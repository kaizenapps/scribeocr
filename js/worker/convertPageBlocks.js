import ocr from '../objects/ocrObjects.js';

import { pass2, pass3 } from './convertPageShared.js';

import { determineSansSerif } from '../fontStatistics.js';

// TODO: Add rotation.

/**
 * @param {Object} params
 * @param {Array<import('tesseract.js').Block>} params.ocrBlocks
 * @param {number} params.n
 * @param {dims} params.pageDims
 * @param {number} params.rotateAngle - The angle that the input image is rotated prior to recognition.
 *    This is used to transform OCR coordinates back to the original coordinate space after recognizing a rotated intermediate image.
 * @param {boolean} params.keepItalic - If true, italic tags (`<em>`) are honored.  This is false by default,
 *    as vanilla Tesseract does not recognize italic text in a way that is reliable.
 *    This is fixed for Legacy recognition in the included custom build of Tesseract.
 */
export async function convertPageBlocks({
  ocrBlocks, n, pageDims, keepItalic, rotateAngle,
}) {
  rotateAngle = rotateAngle || 0;

  const pageObj = new ocr.OcrPage(n, pageDims);

  let wordCount = 0;

  for (let i = 0; i < ocrBlocks.length; i++) {
    const block = ocrBlocks[i];
    for (let j = 0; j < block.paragraphs.length; j++) {
      const paragraphs = block.paragraphs[j];

      for (let k = 0; k < paragraphs.lines.length; k++) {
        const line = paragraphs.lines[k];

        const linebox = {
          left: line.bbox.x0, top: line.bbox.y0, right: line.bbox.x1, bottom: line.bbox.y1,
        };

        const x0 = line.baseline.x0 - linebox.left;
        const x1 = line.baseline.x1 - linebox.left;
        const y0 = line.baseline.y0 - linebox.bottom;
        const y1 = line.baseline.y1 - linebox.bottom;

        const baselineSlope = (y1 - y0) / (x1 - x0);
        const baselinePoint = y0 - baselineSlope * x0;

        const baseline = [baselineSlope, baselinePoint];

        const xHeight = line.rowAttributes.row_height - line.rowAttributes.descenders - line.rowAttributes.ascenders;

        const lineObj = new ocr.OcrLine(pageObj, linebox, baseline, line.rowAttributes.ascenders, xHeight);

        for (let l = 0; l < line.words.length; l++) {
          const word = line.words[l];

          const wordbox = {
            left: word.bbox.x0, top: word.bbox.y0, right: word.bbox.x1, bottom: word.bbox.y1,
          };

          const id = `word_${n + 1}_${wordCount}`;
          wordCount++;

          // Words containing only space characters are skipped.
          if (word.text.trim() === '') continue;

          const wordObj = new ocr.OcrWord(lineObj, word.text, wordbox, id);
          wordObj.lang = word.language;
          wordObj.conf = word.confidence;

          // The `word` object has a `is_italic` property, but it is always false.
          // Therefore, the font name is checked to determine if the word is italic.
          // See: https://github.com/naptha/tesseract.js/issues/907
          if (keepItalic && /italic/i.test(word.font_name)) wordObj.style = 'italic';

          const fontFamily = determineSansSerif(word.font_name);
          if (fontFamily !== 'Default') {
            wordObj.font = fontFamily;
          }

          wordObj.chars = [];
          for (let m = 0; m < word.symbols.length; m++) {
            const symbol = word.symbols[m];

            const symbolbox = {
              left: symbol.bbox.x0, top: symbol.bbox.y0, right: symbol.bbox.x1, bottom: symbol.bbox.y1,
            };

            const charObj = new ocr.OcrChar(symbol.text, symbolbox);

            wordObj.chars.push(charObj);
          }

          lineObj.words.push(wordObj);
        }

        if (lineObj.words.length > 0) pageObj.lines.push(lineObj);
      }
    }
  }

  pageObj.angle = rotateAngle;

  pass2(pageObj, rotateAngle);
  pass3(pageObj);

  return { pageObj, layoutBoxes: {}, warn: { char: '' } };
}