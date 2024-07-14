/* eslint-disable import/no-cycle */

import {
  displayPage,
  initOCRVersion,
  setCurrentHOCR,
} from '../main.js';
import { inputData, opt, state } from './containers/app.js';
import {
  LayoutDataTables,
  ocrAll, pageMetricsArr,
  visInstructions,
} from './containers/dataContainer.js';
import { imageCache } from './containers/imageContainer.js';
import { gs } from './containers/schedulerContainer.js';
import { loadBuiltInFontsRaw, loadChiSimFont } from './fontContainerMain.js';
import { initTesseractInWorkers } from './generalWorkerMain.js';
import { elem } from './gui/elems.js';
import { cp } from './gui/interfaceCanvas.js';
import { ProgressBars } from './gui/utils/progressBars.js';
import { checkCharWarn } from './gui/utils/warningMessages.js';
import { PageMetrics } from './objects/pageMetricsObjects.js';
import { recognizePage } from './recognizeConvert.js';

const showDebugVisElem = /** @type {HTMLInputElement} */(document.getElementById('showDebugVis'));
const showDebugLegendElem = /** @type {HTMLInputElement} */(document.getElementById('showDebugLegend'));
const selectDebugVisElem = /** @type {HTMLSelectElement} */(document.getElementById('selectDebugVis'));

// TODO: Visualizations are added to the dropdown menu, even when they do not exist for every page.
// While this is the appropriate behavior, the user should be notified that the visualization does not exist for the current page.
async function addVisInstructionsUI() {
  const { combineOrderedArrays } = await import('../scrollview-web/util/combine.js');
  if (!visInstructions || visInstructions.length === 0) return;
  const visNamesAll = visInstructions.map((x) => Object.keys(x));
  if (visNamesAll.length === 0) return;
  const visNames = visNamesAll.reduce(combineOrderedArrays);

  if (visNames.length === 0) return;

  showDebugLegendElem.disabled = false;
  selectDebugVisElem.disabled = false;
  visNames.forEach((x) => {
    const optElem = document.createElement('option');
    optElem.value = x;
    optElem.innerHTML = x;
    selectDebugVisElem.appendChild(optElem);
  });
}

/**
 *
 * @param {boolean} legacy
 * @param {boolean} lstm
 * @param {boolean} mainData
 */
export async function recognizeAllPagesBrowser(legacy = true, lstm = true, mainData = false) {
  // Render all PDF pages to PNG if needed
  // This step should not create binarized images as they will be created by Tesseract during recognition.
  if (inputData.pdfMode) await imageCache.preRenderRange(0, imageCache.pageCount - 1, false);

  if (legacy) {
    const oemText = 'Tesseract Legacy';
    initOCRVersion(oemText);
    setCurrentHOCR(oemText);
  }

  if (lstm) {
    const oemText = 'Tesseract LSTM';
    initOCRVersion(oemText);
    setCurrentHOCR(oemText);
  }

  // 'Tesseract Latest' includes the last version of Tesseract to run.
  // It exists only so that data can be consistently displayed during recognition,
  // should never be enabled after recognition is complete, and should never be editable by the user.
  initOCRVersion('Tesseract Latest');
  setCurrentHOCR('Tesseract Latest');

  await initTesseractInWorkers({ anyOk: false, vanillaMode: opt.vanillaMode, langs: opt.langs });

  // If Legacy and LSTM are both requested, LSTM completion is tracked by a second array of promises (`promisesB`).
  // In this case, `convertPageCallbackBrowser` can be run after the Legacy recognition is finished,
  // however this function only returns after all recognition is completed.
  // This provides no performance benefit in absolute terms, however halves the amount of time the user has to wait
  // before seeing the initial recognition results.
  const inputPages = [...Array(imageCache.pageCount).keys()];
  const promisesA = [];
  const resolvesA = [];
  const promisesB = [];
  const resolvesB = [];

  for (let i = 0; i < inputPages.length; i++) {
    promisesA.push(new Promise((resolve, reject) => {
      resolvesA[i] = { resolve, reject };
    }));
    promisesB.push(new Promise((resolve, reject) => {
      resolvesB[i] = { resolve, reject };
    }));
  }

  // Upscaling is enabled only for image data, and only if the user has explicitly enabled it.
  // For PDF data, if upscaling is desired, that should be handled by rendering the PDF at a higher resolution.
  const upscale = inputData.imageMode && elem.recognize.enableUpscale.checked;

  const config = { upscale };

  const debugVis = showDebugVisElem.checked;

  const scheduler = await gs.getScheduler();

  for (const x of inputPages) {
    recognizePage(scheduler, x, legacy, lstm, false, config, debugVis).then(async (resArr) => {
      const res0 = await resArr[0];

      if (res0.recognize.debugVis) {
        const { ScrollView } = await import('../scrollview-web/scrollview/ScrollView.js');
        const sv = new ScrollView(true);
        await sv.processVisStr(res0.recognize.debugVis);
        visInstructions[x] = await sv.getAll(true);
      }

      if (legacy) {
        await convertPageCallbackBrowser(res0.convert.legacy, x, mainData, 'Tesseract Legacy');
        resolvesA[x].resolve();
      } else if (lstm) {
        await convertPageCallbackBrowser(res0.convert.lstm, x, false, 'Tesseract LSTM');
        resolvesA[x].resolve();
      }

      if (legacy && lstm) {
        (async () => {
          const res1 = await resArr[1];
          await convertPageCallbackBrowser(res1.convert.lstm, x, false, 'Tesseract LSTM');
          resolvesB[x].resolve();
        })();
      }
    });
  }

  await Promise.all(promisesA);

  if (debugVis) addVisInstructionsUI();

  if (mainData) {
    await checkCharWarn(state.convertPageWarn);
  }

  if (legacy && lstm) await Promise.all(promisesB);

  if (lstm) {
    const oemText = 'Tesseract LSTM';
    setCurrentHOCR(oemText);
  } else {
    const oemText = 'Tesseract Legacy';
    setCurrentHOCR(oemText);
  }
}

/**
 * This function is called after running a `convertPage` (or `recognizeAndConvert`) function, updating the globals with the results.
 * This needs to be a separate function from `convertOCRPage`, given that sometimes recognition and conversion are combined by using `recognizeAndConvert`.
 *
 * @param {Awaited<ReturnType<typeof import('./worker/generalWorker.js').recognizeAndConvert>>['convert']} params
 * @param {number} n
 * @param {boolean} mainData
 * @param {string} engineName - Name of OCR engine.
 * @returns
 */
export async function convertPageCallbackBrowser({
  pageObj, dataTables, warn, langSet,
}, n, mainData, engineName) {
  if (engineName) ocrAll[engineName][n] = pageObj;

  const fontPromiseArr = [];
  if (langSet.has('chi_sim')) fontPromiseArr.push(loadChiSimFont());
  if (langSet.has('rus') || langSet.has('ell')) fontPromiseArr.push(loadBuiltInFontsRaw('all'));
  await Promise.all(fontPromiseArr);

  if (['Tesseract Legacy', 'Tesseract LSTM'].includes(engineName)) ocrAll['Tesseract Latest'][n] = pageObj;

  // If this is flagged as the "main" data, then save the stats.
  if (mainData) {
    state.convertPageWarn[n] = warn;

    // The page metrics object may have been initialized earlier through some other method (e.g. using PDF info).
    if (!pageMetricsArr[n]) {
      pageMetricsArr[n] = new PageMetrics(pageObj.dims);
    }

    pageMetricsArr[n].angle = pageObj.angle;
  }

  inputData.xmlMode[n] = true;

  // Layout boxes are only overwritten if none exist yet for the page
  if (Object.keys(LayoutDataTables.pages[n].tables).length === 0) LayoutDataTables.pages[n] = dataTables;

  // If this is the page the user has open, render it to the canvas
  const oemActive = document.getElementById('displayLabelText')?.innerHTML;

  // Display the page if either (1) this is the currently active OCR or (2) this is Tesseract Legacy and Tesseract LSTM is active, but does not exist yet.
  // The latter condition occurs briefly whenever recognition is run in "Quality" mode.
  const displayOCR = engineName === oemActive || ['Tesseract Legacy', 'Tesseract LSTM'].includes(engineName) && oemActive === 'Tesseract Latest';

  if (n === cp.n && displayOCR) displayPage(cp.n);

  ProgressBars.active.increment();
}

/**
 * Convert from raw OCR data to the internal hocr format used here
 * Currently supports .hocr (used by Tesseract), Abbyy .xml, and stext (an intermediate data format used by mupdf).
 *
 * @param {string} ocrRaw - String containing raw OCR data for single page.
 * @param {number} n - Page number
 * @param {boolean} mainData - Whether this is the "main" data that document metrics are calculated from.
 *  For imports of user-provided data, the first data provided should be flagged as the "main" data.
 *  For Tesseract.js recognition, the Tesseract Legacy results should be flagged as the "main" data.
 * @param {("hocr"|"abbyy"|"stext"|"blocks")} format - Format of raw data.
 * @param {string} engineName - Name of OCR engine.
 * @param {boolean} [scribeMode=false] - Whether this is HOCR data from this program.
 */
async function convertOCRPageBrowser(ocrRaw, n, mainData, format, engineName, scribeMode = false) {
  let func = 'convertPageHocr';
  if (format === 'abbyy') {
    func = 'convertPageAbbyy';
  } else if (format === 'stext') {
    func = 'convertPageStext';
  } else if (format === 'blocks') {
    func = 'convertPageBlocks';
  }

  await gs.schedulerReady;

  const res = await gs.schedulerInner.addJob(func, { ocrStr: ocrRaw, n, scribeMode });

  await convertPageCallbackBrowser(res, n, mainData, engineName);
}

/**
 * Convert from raw OCR data to the internal hocr format used here
 * Currently supports .hocr (used by Tesseract), Abbyy .xml, and stext (an intermediate data format used by mupdf).
 *
 * @param {string[]} ocrRawArr - Array with raw OCR data, with an element for each page
 * @param {boolean} mainData - Whether this is the "main" data that document metrics are calculated from.
 *  For imports of user-provided data, the first data provided should be flagged as the "main" data.
 *  For Tesseract.js recognition, the Tesseract Legacy results should be flagged as the "main" data.
 * @param {("hocr"|"abbyy"|"stext")} format - Format of raw data.
 * @param {string} engineName - Name of OCR engine.
 * @param {boolean} [scribeMode=false] - Whether this is HOCR data from this program.
 */
export async function convertOCRAllBrowser(ocrRawArr, mainData, format, engineName, scribeMode = false) {
  // For each page, process OCR using web worker
  const promiseArr = [];
  for (let n = 0; n < ocrRawArr.length; n++) {
    promiseArr.push(convertOCRPageBrowser(ocrRawArr[n], n, mainData, format, engineName, scribeMode));
  }
  await Promise.all(promiseArr);
}
