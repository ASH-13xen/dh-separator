// Local, no-Cloudinary variant of generateSubjectBookPdf.js. Instead of rebuilding the
// question hierarchy from raw CSV rows (like the CI runner does, keyed off a SubjectBook
// job document), this sources data the same way the live book-builder UI does — via
// utils/bookLayout.js's applyBookLayout/mergeSyllabusIntoHierarchy/deriveIncludedAndSelections
// — so a locally-generated PDF reflects every saved layout customization (topic order/renames,
// question order, exclusions, topper selections/overrides, question text overrides, inserted
// title pages) exactly as the editor currently shows them, with zero duplicate logic to drift
// out of sync. Output is written straight to local disk; nothing is uploaded anywhere.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PDFDocument, rgb, StandardFonts, PDFString } from 'pdf-lib';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Subject } from '../models/Subject.js';
import { BookLayout } from '../models/BookLayout.js';
import { parseCSV, cleanYear } from '../utils/csv.js';
import { applyBookLayout, mergeSyllabusIntoHierarchy, deriveIncludedAndSelections } from '../utils/bookLayout.js';

console.log('[Local] Script loaded. Starting local PDF generation pipeline...');
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const RASTER_DPI = 72;
const RASTER_QUALITY = 45;

// Path to pdftoppm.exe. Override with PDFTOPPM_PATH env var if not on PATH (e.g. a portable
// poppler-windows extraction, since this machine has no system-wide poppler install).
const PDFTOPPM_PATH = process.env.PDFTOPPM_PATH || 'pdftoppm';

// --- Verbatim from generateSubjectBookPdf.js (kept identical so local output matches prod) ---

async function rasterizePdfToJpegs(pdfBuffer, dpi, quality) {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempPdfPath = path.join(os.tmpdir(), `book-src-${uniqueId}.pdf`);
  const outPrefix = path.join(os.tmpdir(), `book-out-${uniqueId}`);

  fs.writeFileSync(tempPdfPath, pdfBuffer);
  try {
    await execFileAsync(PDFTOPPM_PATH, ['-jpeg', '-r', String(dpi), '-jpegopt', `quality=${quality}`, tempPdfPath, outPrefix]);

    const dir = path.dirname(outPrefix);
    const baseName = path.basename(outPrefix);
    const outputFiles = fs.readdirSync(dir)
      .filter(f => f.startsWith(baseName) && f.endsWith('.jpg'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
        const numB = parseInt(b.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
        return numA - numB;
      });

    return outputFiles.map(f => {
      const fullPath = path.join(dir, f);
      const buf = fs.readFileSync(fullPath);
      fs.unlinkSync(fullPath);
      return buf;
    });
  } finally {
    if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
  }
}

function sanitizeForPdf(str) {
  if (!str) return "";
  return str
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[—–]/g, '-')
      .replace(/ /g, ' ')
      .replace(/…/g, '...')
      .replace(/[^\x00-\xff]/g, '');
}

function addLinkAnnotation(doc, page, { x, y, width, height, url }) {
  const linkAnnotRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, y, x + width, y + height],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) }
    })
  );
  page.node.addAnnot(linkAnnotRef);
}

function drawPaginatedTable(doc, fontBold, fontNormal, pageWidth, pageHeight, title, columns, rows) {
  const tableX = 50;
  const tableW = pageWidth - 100;
  const lineHeight = 11;
  const cellPaddingY = 6;
  const headerRowHeight = 26;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - 80;
  let isFirstPage = true;

  const drawHeading = () => {
    const text = isFirstPage ? title : `${title} (Cont.)`;
    page.drawText(text, { x: 50, y, size: isFirstPage ? 20 : 16, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
    y -= isFirstPage ? 40 : 30;
  };

  const drawHeaderRow = () => {
    page.drawRectangle({ x: tableX, y: y - headerRowHeight, width: tableW, height: headerRowHeight, color: rgb(0.15, 0.18, 0.32) });
    let colX = tableX;
    columns.forEach(col => {
      const headerW = fontBold.widthOfTextAtSize(col.header, 9);
      const headerX = col.align === 'right' ? colX + col.width - 8 - headerW : colX + 8;
      page.drawText(col.header, { x: headerX, y: y - 17, size: 9, font: fontBold, color: rgb(1, 1, 1) });
      colX += col.width;
    });
    y -= headerRowHeight;
  };

  const wrapCellText = (text, width, size, font) => {
    const words = sanitizeForPdf(String(text ?? '')).replace(/\n/g, ' ').split(' ').filter(Boolean);
    if (words.length === 0) return [''];
    const lines = [];
    let current = '';
    const maxW = width - 16;

    for (let word of words) {
      while (font.widthOfTextAtSize(word, size) > maxW) {
        if (current) { lines.push(current); current = ''; }
        let cut = 1;
        while (cut < word.length && font.widthOfTextAtSize(word.slice(0, cut + 1), size) <= maxW) cut++;
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > maxW && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  };

  drawHeading();
  drawHeaderRow();

  rows.forEach((row, rowIdx) => {
    const wrappedCells = row.map((cellText, ci) => wrapCellText(cellText, columns[ci].width, 8, fontNormal));
    const maxLines = Math.max(...wrappedCells.map(l => l.length));
    const rowHeight = maxLines * lineHeight + cellPaddingY;

    if (y - rowHeight < 50) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - 80;
      isFirstPage = false;
      drawHeading();
      drawHeaderRow();
    }

    if (rowIdx % 2 === 0) {
      page.drawRectangle({ x: tableX, y: y - rowHeight, width: tableW, height: rowHeight, color: rgb(0.96, 0.97, 0.99) });
    }

    let colX = tableX;
    wrappedCells.forEach((lines, ci) => {
      const col = columns[ci];
      lines.forEach((line, li) => {
        const lineW = fontNormal.widthOfTextAtSize(line, 8);
        const lineX = col.align === 'right' ? colX + col.width - 8 - lineW : colX + 8;
        page.drawText(line, { x: lineX, y: y - (li + 1) * lineHeight + 1, size: 8, font: fontNormal, color: rgb(0.15, 0.15, 0.2) });
      });
      colX += col.width;
    });

    page.drawLine({ start: { x: tableX, y: y - rowHeight }, end: { x: tableX + tableW, y: y - rowHeight }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
    y -= rowHeight;
  });
}

async function fetchUrlsInParallel(urls, concurrencyLimit = 5) {
  const results = {};
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  console.log(`[Local] [fetchUrlsInParallel] Total unique URLs to pre-fetch: ${uniqueUrls.length} (Concurrency limit: ${concurrencyLimit})`);

  for (let i = 0; i < uniqueUrls.length; i += concurrencyLimit) {
    const chunk = uniqueUrls.slice(i, i + concurrencyLimit);
    console.log(`[Local] [fetchUrlsInParallel] Fetching chunk: ${i + 1} to ${Math.min(uniqueUrls.length, i + concurrencyLimit)}`);
    const promises = chunk.map(async (url) => {
      const cleanUrl = url.replace('https//', 'https://').replace('http//', 'http://');
      try {
        const res = await fetch(cleanUrl);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const buffer = await res.arrayBuffer();
        results[url] = buffer;
        console.log(`[Local] [fetchUrlsInParallel] Successfully pre-fetched: ${cleanUrl} (${buffer.byteLength} bytes)`);
      } catch (err) {
        console.error(`[Local] [fetchUrlsInParallel] Failed to pre-fetch URL: ${cleanUrl}`, err);
        results[url] = null;
      }
    });
    await Promise.all(promises);
  }
  return results;
}

// --- Local-pipeline-specific: CSV -> Paper>Topic>Question hierarchy (mirrors subjectController.js's
// buildHierarchyFromRows exactly, copied rather than imported since it isn't exported there) ---

function buildHierarchyFromRows(rows) {
  const hierarchy = {};
  rows.forEach(r => {
    if (r.length < 10) return;
    const section = r[0].trim();
    const topic = r[1].trim();
    const questionText = r[2].trim();
    const topperName = r[3].trim();
    const topperYear = cleanYear(r[4].trim());
    const topperRank = r[5].trim();
    const topperMarks = r[6].trim();
    const url = r[7].trim();
    const paper = r[9].trim();

    if (!questionText || !paper) return;
    if (!hierarchy[paper]) hierarchy[paper] = { paper, section, topics: {} };
    const paperObj = hierarchy[paper];
    if (!paperObj.topics[topic]) paperObj.topics[topic] = { title: topic, questions: {} };
    const topicObj = paperObj.topics[topic];
    const qKey = `${paper}||${section}||${topic}||${questionText}`;
    if (!topicObj.questions[qKey]) {
      topicObj.questions[qKey] = { _id: Buffer.from(qKey).toString('base64'), question_text: questionText, file_urls: [] };
    }
    if (url) {
      topicObj.questions[qKey].file_urls.push({
        url, topper_name: topperName || 'Unknown Topper', topper_year: topperYear || '',
        topper_rank: topperRank || '', topper_marks: topperMarks || ''
      });
    }
  });

  const result = Object.values(hierarchy).map(paperObj => {
    const topicsArray = Object.values(paperObj.topics).map(topObj => ({
      title: topObj.title, _key: topObj.title, questions: Object.values(topObj.questions)
    }));
    topicsArray.sort((a, b) => a.title.localeCompare(b.title));
    return { paper: paperObj.paper, section: paperObj.section, topics: topicsArray };
  });
  result.sort((a, b) => a.paper.localeCompare(b.paper, undefined, { numeric: true, sensitivity: 'base' }));
  return result;
}

// --- Renders one paper's full content (section divider > topic dividers > subtopic dividers >
// question pages) into the shared pdfDoc. Returns index/summary rows for that paper so a
// caller compiling multiple papers into one book can accumulate a single combined TOC. ---

async function renderPaperIntoDoc(pdfDoc, { fontBold, fontNormal, dhLogoImage, tw, th }, paperNode, includedIds, selections, fetchedBuffers) {
  const indexData = [];
  const summaryRows = [];

  const includedSet = new Set(includedIds);
  const topics = paperNode.topics
    .map(t => ({ ...t, questions: t.questions.filter(q => includedSet.has(q._id)) }))
    .filter(t => t.questions.length > 0);

  console.log(`[Local] Processing Section: ${paperNode.section}`);
  indexData.push({ type: 'section', text: `${paperNode.paper} - ${paperNode.section}`, targetPageInternal: pdfDoc.getPageCount() });

  const sPage = pdfDoc.addPage();
  sPage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(0.12, 0.15, 0.28) });
  sPage.drawText("SECTION", { x: 50, y: th - 150, size: 24, font: fontNormal, color: rgb(0.7, 0.8, 0.95) });
  sPage.drawLine({ start: { x: 50, y: th - 158 }, end: { x: 50 + fontNormal.widthOfTextAtSize("SECTION", 24), y: th - 158 }, thickness: 1.5, color: rgb(0.7, 0.8, 0.95) });

  let sY = th - 200;
  const sWords = sanitizeForPdf(`${paperNode.paper}: ${paperNode.section}`).toUpperCase().split(' ');
  let sLine = '';
  for (const word of sWords) {
    const testLine = sLine + word + ' ';
    if (fontBold.widthOfTextAtSize(testLine, 18) > tw - 100) {
      sPage.drawText(sanitizeForPdf(sLine), { x: 50, y: sY, size: 18, font: fontBold, color: rgb(1, 1, 1) });
      sLine = word + ' ';
      sY -= 25;
    } else {
      sLine = testLine;
    }
  }
  sPage.drawText(sanitizeForPdf(sLine), { x: 50, y: sY, size: 18, font: fontBold, color: rgb(1, 1, 1) });

  for (const topNode of topics) {
    console.log(`  - Topic: ${topNode.title}`);
    indexData.push({ type: 'topic', text: topNode.title, targetPageInternal: pdfDoc.getPageCount() });

    const tPage = pdfDoc.addPage();
    tPage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(0.18, 0.22, 0.35) });
    tPage.drawText("TOPIC", { x: 50, y: th - 150, size: 24, font: fontNormal, color: rgb(0.8, 0.85, 0.95) });
    tPage.drawLine({ start: { x: 50, y: th - 158 }, end: { x: 50 + fontNormal.widthOfTextAtSize("TOPIC", 24), y: th - 158 }, thickness: 1.5, color: rgb(0.8, 0.85, 0.95) });

    let tY = th - 200;
    const tWords = sanitizeForPdf(topNode.title).toUpperCase().split(' ');
    let tLine = '';
    for (const word of tWords) {
      const testLine = tLine + word + ' ';
      if (fontBold.widthOfTextAtSize(testLine, 18) > tw - 100) {
        tPage.drawText(sanitizeForPdf(tLine), { x: 50, y: tY, size: 18, font: fontBold, color: rgb(1, 1, 1) });
        tLine = word + ' ';
        tY -= 25;
      } else {
        tLine = testLine;
      }
    }
    tPage.drawText(sanitizeForPdf(tLine), { x: 50, y: tY, size: 18, font: fontBold, color: rgb(1, 1, 1) });

    for (let qIdx = 0; qIdx < topNode.questions.length; qIdx++) {
      const item = topNode.questions[qIdx];

      if (item.isTitlePage) {
        console.log(`    * Subsection divider ${qIdx + 1}/${topNode.questions.length}: "${item.subtitle}"`);
        indexData.push({ type: 'subtopic', text: item.subtitle, targetPageInternal: pdfDoc.getPageCount() });

        const dPage = pdfDoc.addPage();
        const dBlue = rgb(0.07, 0.18, 0.62);
        dPage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(1, 1, 1) });
        const wmSize = 300;
        dPage.drawImage(dhLogoImage, { x: (tw - wmSize) / 2, y: (th - wmSize) / 2, width: wmSize, height: wmSize, opacity: 0.1 });
        dPage.drawText("SUB-TOPIC", { x: 50, y: th - 140, size: 20, font: fontBold, color: dBlue });
        dPage.drawLine({ start: { x: 50, y: th - 150 }, end: { x: 50 + fontBold.widthOfTextAtSize("SUB-TOPIC", 20), y: th - 150 }, thickness: 1.5, color: dBlue });

        let dY = th - 196;
        const dWords = sanitizeForPdf(item.subtitle).toUpperCase().split(' ');
        let dLine = '';
        for (const word of dWords) {
          const testLine = dLine + word + ' ';
          if (fontBold.widthOfTextAtSize(testLine, 26) > tw - 100) {
            dPage.drawText(sanitizeForPdf(dLine), { x: 50, y: dY, size: 26, font: fontBold, color: dBlue });
            dLine = word + ' ';
            dY -= 34;
          } else {
            dLine = testLine;
          }
        }
        dPage.drawText(sanitizeForPdf(dLine), { x: 50, y: dY, size: 26, font: fontBold, color: dBlue });

        const footerSize = 13;
        const footerY = 40;
        const websiteText = "Website: www.darkhorseupsc.com";
        const websiteWidth = fontNormal.widthOfTextAtSize(websiteText, footerSize);
        dPage.drawText(websiteText, { x: 50, y: footerY, size: footerSize, font: fontNormal, color: rgb(0.4, 0.4, 0.4) });
        addLinkAnnotation(pdfDoc, dPage, { x: 50, y: footerY - 2, width: websiteWidth, height: footerSize + 4, url: 'https://www.darkhorseupsc.com' });

        const telegramText = "Telegram: https://t.me/darkhorsecse";
        const telegramWidth = fontNormal.widthOfTextAtSize(telegramText, footerSize);
        dPage.drawText(telegramText, { x: tw - 50 - telegramWidth, y: footerY, size: footerSize, font: fontNormal, color: rgb(0.4, 0.4, 0.4) });
        addLinkAnnotation(pdfDoc, dPage, { x: tw - 50 - telegramWidth, y: footerY - 2, width: telegramWidth, height: footerSize + 4, url: 'https://t.me/darkhorsecse' });

        continue;
      }

      console.log(`    * Question ${qIdx + 1}/${topNode.questions.length}: ID='${item._id}'`);

      let activeFileObjects = [];
      if (item.file_urls && item.file_urls.length > 0) {
        if (selections && selections[item._id]) {
          const selectedUrls = Array.isArray(selections[item._id]) ? selections[item._id] : [selections[item._id]];
          activeFileObjects = item.file_urls.filter(f => selectedUrls.includes(f.url));
        }
        if (activeFileObjects.length === 0 && item.file_urls.length > 0) {
          activeFileObjects = [item.file_urls[0]];
        }
      }

      const wrapText = (text, size, maxW, font) => {
        const sanitized = sanitizeForPdf(text);
        const words = sanitized.replace(/\n/g, ' ').split(' ');
        const lines = [];
        let currentLine = '';
        for (const word of words) {
          const testLine = currentLine ? `${currentLine} ${word}` : word;
          const w = font.widthOfTextAtSize(testLine, size);
          if (w > maxW) { lines.push(currentLine); currentLine = word; } else { currentLine = testLine; }
        }
        if (currentLine) lines.push(currentLine);
        return lines;
      };

      const rawText = item.question_text || "Question text unavailable.";
      const prefixMatch = rawText.match(/^(?:Q\s*\d+|Q\.\s*\d+|Question\s*\d+)[.)\s:-]*/i);
      let cleanText = rawText;
      if (prefixMatch) cleanText = rawText.substring(prefixMatch[0].length).trim();

      summaryRows.push({
        topic: topNode.title,
        questionText: cleanText,
        toppers: activeFileObjects.map(f => ({ name: f.topper_name || 'Unknown Topper', year: f.topper_year || '', rank: f.topper_rank || '', marks: f.topper_marks || '' }))
      });

      if (activeFileObjects.length > 0) {
        console.log(`      Found ${activeFileObjects.length} active topper sheets for this question.`);
        for (const activeFileObj of activeFileObjects) {
          const cloudUrl = activeFileObj.url.replace('https//', 'https://').replace('http//', 'http://');
          console.log(`      Embedding topper note: ${activeFileObj.topper_name} (${cloudUrl})`);
          try {
            const arrayBuffer = fetchedBuffers[activeFileObj.url];
            if (!arrayBuffer) throw new Error(`Buffer not found for pre-fetched URL: ${cloudUrl}`);
            const jpegPages = await rasterizePdfToJpegs(Buffer.from(arrayBuffer), RASTER_DPI, RASTER_QUALITY);
            console.log(`      Rasterized source PDF to ${jpegPages.length} compressed page(s) (${RASTER_DPI}dpi, q${RASTER_QUALITY}).`);

            if (jpegPages.length > 0) {
              const firstJpeg = await pdfDoc.embedJpg(jpegPages[0]);
              const sw = firstJpeg.width;
              const sh = firstJpeg.height;

              const maxQWidth = tw - 60;
              const qLines = wrapText(cleanText, 9, maxQWidth, fontNormal);
              const maxVisibleLines = Math.min(qLines.length, 5);
              const highlightHeight = 40 + maxVisibleLines * 12;
              const headerHeight = 15 + highlightHeight + 10;

              const newPage = pdfDoc.addPage([tw, th]);
              newPage.drawRectangle({ x: 20, y: th - 15 - highlightHeight, width: tw - 40, height: highlightHeight, color: rgb(0.99, 0.96, 0.80) });

              const tName = activeFileObj.topper_name || 'Unknown Topper';
              const tYear = activeFileObj.topper_year || 'N/A';
              const tagMetaParts = [tYear];
              if (activeFileObj.topper_rank) tagMetaParts.push(`Rank ${activeFileObj.topper_rank}`);
              if (activeFileObj.topper_marks) tagMetaParts.push(`Marks ${activeFileObj.topper_marks}`);
              const topperTagStr = sanitizeForPdf(`${tName} (${tagMetaParts.join(', ')})`);
              const tagWidth = fontBold.widthOfTextAtSize(topperTagStr, 10);
              newPage.drawText(topperTagStr, { x: (tw - tagWidth) / 2, y: th - 30, size: 10, font: fontBold, color: rgb(0, 0, 0) });

              let qTextY = th - 45;
              const qLineHeight = 12;
              for (let l = 0; l < maxVisibleLines; l++) {
                let line = qLines[l];
                if (l === maxVisibleLines - 1 && qLines.length > maxVisibleLines) line += '...';
                const lineW = fontNormal.widthOfTextAtSize(line, 9);
                newPage.drawText(line, { x: (tw - lineW) / 2, y: qTextY, size: 9, font: fontNormal, color: rgb(0, 0, 0) });
                qTextY -= qLineHeight;
              }

              const remainingWidth = tw - 40;
              const remainingHeight = th - headerHeight - 25;
              const scaleX = remainingWidth / sw;
              const scaleY = remainingHeight / sh;
              const scale = Math.min(scaleX, scaleY);
              const drawWidth = sw * scale;
              const drawHeight = sh * scale;
              const drawX = 20 + (remainingWidth - drawWidth) / 2;
              const drawY = 15 + (remainingHeight - drawHeight) / 2;
              newPage.drawImage(firstJpeg, { x: drawX, y: drawY, width: drawWidth, height: drawHeight });

              if (jpegPages.length > 1) {
                console.log(`      Embedding ${jpegPages.length - 1} subsequent page(s)...`);
                for (let pIdx = 1; pIdx < jpegPages.length; pIdx++) {
                  const pageJpeg = await pdfDoc.embedJpg(jpegPages[pIdx]);
                  const pw = pageJpeg.width;
                  const ph = pageJpeg.height;
                  const pRemainingWidth = tw - 40;
                  const pRemainingHeight = th - 40;
                  const pScale = Math.min(pRemainingWidth / pw, pRemainingHeight / ph);
                  const pDrawWidth = pw * pScale;
                  const pDrawHeight = ph * pScale;
                  const pDrawX = (tw - pDrawWidth) / 2;
                  const pDrawY = (th - pDrawHeight) / 2;
                  const subsequentPage = pdfDoc.addPage([tw, th]);
                  subsequentPage.drawImage(pageJpeg, { x: pDrawX, y: pDrawY, width: pDrawWidth, height: pDrawHeight });
                }
              }
            } else {
              throw new Error("Answer PDF contains no pages.");
            }
          } catch (pdfErr) {
            console.error(`      Error appending PDF ${cloudUrl}:`, pdfErr);
            const errPage = pdfDoc.addPage([tw, th]);
            errPage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(0.98, 0.95, 0.95) });
            const maxQWidth = tw - 60;
            const qLines = wrapText(cleanText, 9, maxQWidth, fontNormal);
            const maxVisibleLines = Math.min(qLines.length, 5);
            const highlightHeight = 40 + maxVisibleLines * 12;
            errPage.drawRectangle({ x: 20, y: th - 15 - highlightHeight, width: tw - 40, height: highlightHeight, color: rgb(0.99, 0.96, 0.80) });
            const tName = activeFileObj.topper_name || 'Unknown Topper';
            const topperTagStr = `${tName} (ANSWER SHEET LOAD ERROR)`;
            const tagWidth = fontBold.widthOfTextAtSize(topperTagStr, 10);
            errPage.drawText(topperTagStr, { x: (tw - tagWidth) / 2, y: th - 30, size: 10, font: fontBold, color: rgb(0.8, 0.2, 0.2) });
            let qTextY = th - 45;
            const qLineHeight = 12;
            for (let l = 0; l < maxVisibleLines; l++) {
              let line = qLines[l];
              if (l === maxVisibleLines - 1 && qLines.length > maxVisibleLines) line += '...';
              const lineW = fontNormal.widthOfTextAtSize(line, 9);
              errPage.drawText(line, { x: (tw - lineW) / 2, y: qTextY, size: 9, font: fontNormal, color: rgb(0, 0, 0) });
              qTextY -= qLineHeight;
            }
            const warnY = th - 15 - highlightHeight - 120;
            errPage.drawRectangle({ x: 40, y: warnY, width: tw - 80, height: 95, color: rgb(1, 1, 1), borderColor: rgb(0.9, 0.7, 0.7), borderWidth: 1 });
            errPage.drawText("TEMPORARILY UNAVAILABLE", { x: tw / 2 - 95, y: warnY + 65, size: 14, font: fontBold, color: rgb(0.8, 0.2, 0.2) });
            errPage.drawText("The system encountered an error trying to fetch or render this topper's response.", { x: tw / 2 - 200, y: warnY + 40, size: 9, font: fontNormal, color: rgb(0.5, 0.3, 0.3) });
            errPage.drawText(`URL: ${cloudUrl}`, { x: tw / 2 - 200, y: warnY + 20, size: 8, font: fontNormal, color: rgb(0.6, 0.6, 0.6) });
          }
        }
      } else {
        console.log('      No toppers selected for this question. Drawing placeholder page.');
        const qPage = pdfDoc.addPage([tw, th]);
        qPage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(0.97, 0.98, 0.99) });
        const maxQWidth = tw - 60;
        const qLines = wrapText(cleanText, 9, maxQWidth, fontNormal);
        const maxVisibleLines = Math.min(qLines.length, 5);
        const highlightHeight = 40 + maxVisibleLines * 12;
        qPage.drawRectangle({ x: 20, y: th - 15 - highlightHeight, width: tw - 40, height: highlightHeight, color: rgb(0.99, 0.96, 0.80) });
        const headerLabel = "NO TOPPER RESPONSE SELECTED";
        const labelW = fontBold.widthOfTextAtSize(headerLabel, 10);
        qPage.drawText(headerLabel, { x: (tw - labelW) / 2, y: th - 30, size: 10, font: fontBold, color: rgb(0.8, 0.2, 0.2) });
        let qTextY = th - 45;
        const qLineHeight = 12;
        for (let l = 0; l < maxVisibleLines; l++) {
          let line = qLines[l];
          if (l === maxVisibleLines - 1 && qLines.length > maxVisibleLines) line += '...';
          const lineW = fontNormal.widthOfTextAtSize(line, 9);
          qPage.drawText(line, { x: (tw - lineW) / 2, y: qTextY, size: 9, font: fontNormal, color: rgb(0, 0, 0) });
          qTextY -= qLineHeight;
        }
        const warnY = th - 15 - highlightHeight - 120;
        qPage.drawRectangle({ x: 40, y: warnY, width: tw - 80, height: 95, color: rgb(0.98, 0.94, 0.94), borderColor: rgb(0.9, 0.8, 0.8), borderWidth: 1 });
        qPage.drawText("INFORMATION NOT AVAILABLE", { x: 55, y: warnY + 70, size: 9, font: fontBold, color: rgb(0.8, 0.2, 0.2) });
        qPage.drawText("No topper answer sheets are currently selected or uploaded for this question.", { x: 55, y: warnY + 45, size: 11, font: fontBold, color: rgb(0.6, 0.2, 0.2) });
        qPage.drawText("Once a topper paper is linked and selected, the responses will be compiled directly following this layout page.", { x: 55, y: warnY + 20, size: 8, font: fontNormal, color: rgb(0.5, 0.5, 0.6) });
      }
    }
  }

  return { indexData, summaryRows };
}

// --- Cover / TOC / summary / page-numbering: same visual system as generateSubjectBookPdf.js ---

function drawCoverPage(pdfDoc, fontBold, fontNormal, subjectName, headline, subheadline) {
  const titlePage = pdfDoc.addPage();
  const { width: tw, height: th } = titlePage.getSize();

  titlePage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(0.98, 0.98, 0.99) });
  titlePage.drawRectangle({ x: 0, y: th - 180, width: tw, height: 180, color: rgb(0.12, 0.18, 0.35) });
  titlePage.drawRectangle({ x: 0, y: th - 180, width: tw * 0.6, height: 10, color: rgb(0.96, 0.35, 0.14) });
  titlePage.drawRectangle({ x: 0, y: th - 180, width: tw * 0.4, height: 10, color: rgb(0.25, 0.51, 0.96) });

  titlePage.drawText(sanitizeForPdf(`${subjectName.toUpperCase()} SERIES`), { x: 50, y: th - 85, size: 32, font: fontBold, color: rgb(1, 1, 1) });
  titlePage.drawText(sanitizeForPdf(subjectName), { x: 50, y: th - 125, size: 15, font: fontNormal, color: rgb(0.8, 0.8, 0.9) });

  let fontSize = 32;
  const subWrapped = sanitizeForPdf(subheadline);
  let textWidth = fontBold.widthOfTextAtSize(subWrapped, fontSize);
  while (textWidth > tw - 80 && fontSize > 16) { fontSize -= 2; textWidth = fontBold.widthOfTextAtSize(subWrapped, fontSize); }

  titlePage.drawText(headline, { x: 50, y: th / 2 + 50, size: 40, font: fontBold, color: rgb(0.12, 0.18, 0.35) });
  titlePage.drawText(subWrapped, { x: 50, y: th / 2 - 10, size: fontSize, font: fontBold, color: rgb(0.2, 0.2, 0.2) });

  titlePage.drawRectangle({ x: 50, y: 150, width: tw - 100, height: 2, color: rgb(0.8, 0.8, 0.8) });
  titlePage.drawText(`AI-Structured Handwritten Answers Library`, { x: 50, y: 110, size: 14, font: fontNormal, color: rgb(0.4, 0.4, 0.4) });
  titlePage.drawText(`${new Date().getFullYear()} Edition`, { x: 50, y: 80, size: 14, font: fontBold, color: rgb(0.96, 0.35, 0.14) });

  return { tw, th };
}

async function buildBook({ subjectSlug, papers, outFile }) {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI missing from environment.');

  console.log('[Local] Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[Local] MongoDB connected.');

  const subjectDoc = await Subject.findOne({ slug: subjectSlug });
  if (!subjectDoc || !subjectDoc.csvData) throw new Error(`Subject not found or has no classified questions: ${subjectSlug}`);

  const parsed = parseCSV(subjectDoc.csvData);
  const rows = parsed.slice(1);
  const rawHierarchy = buildHierarchyFromRows(rows);
  const hierarchyWithSyllabus = mergeSyllabusIntoHierarchy(rawHierarchy, subjectDoc.syllabusJson);

  const layoutDocs = await BookLayout.find({ subject: subjectSlug }).lean();
  const layoutsByPaper = Object.fromEntries(layoutDocs.map(l => [l.paper, l]));
  const mergedHierarchy = applyBookLayout(hierarchyWithSyllabus, layoutsByPaper);
  const { excludedQuestionIds, selections } = deriveIncludedAndSelections(mergedHierarchy, layoutsByPaper);
  const excludedSet = new Set(excludedQuestionIds);

  let targetPapers = mergedHierarchy;
  if (papers && papers.length > 0) {
    const wanted = new Set(papers);
    targetPapers = mergedHierarchy.filter(p => wanted.has(p.paper));
    const missing = papers.filter(p => !mergedHierarchy.some(h => h.paper === p));
    if (missing.length > 0) {
      console.warn(`[Local] WARNING: requested paper(s) not found in hierarchy: ${missing.join(' | ')}`);
      console.warn(`[Local] Available papers: ${mergedHierarchy.map(h => h.paper).join(' | ')}`);
    }
  }
  if (targetPapers.length === 0) throw new Error('No matching papers to compile.');

  console.log(`[Local] Compiling ${targetPapers.length} paper(s): ${targetPapers.map(p => p.paper).join(', ')}`);

  const pdfDoc = await PDFDocument.create();
  const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const dhLogoImage = await pdfDoc.embedJpg(fs.readFileSync(path.join(__dirname, '..', 'dhlogo.jpg')));

  const isMultiPaper = targetPapers.length > 1;
  const headline = isMultiPaper ? 'COMPLETE BOOK' : targetPapers[0].paper;
  const subheadline = isMultiPaper ? `All ${targetPapers.length} Units Compiled` : targetPapers[0].section;
  const { tw, th } = drawCoverPage(pdfDoc, fontBold, fontNormal, subjectDoc.name, headline, subheadline);

  // Pre-fetch every topper URL across every paper being compiled, in one batch.
  const urlsToFetch = [];
  targetPapers.forEach(paperNode => {
    paperNode.topics.forEach(topNode => {
      topNode.questions.forEach(item => {
        if (item.isTitlePage || excludedSet.has(item._id)) return;
        let activeFileObjects = [];
        if (item.file_urls && item.file_urls.length > 0) {
          if (selections && selections[item._id]) {
            const selectedUrls = Array.isArray(selections[item._id]) ? selections[item._id] : [selections[item._id]];
            activeFileObjects = item.file_urls.filter(f => selectedUrls.includes(f.url));
          }
          if (activeFileObjects.length === 0 && item.file_urls.length > 0) activeFileObjects = [item.file_urls[0]];
        }
        activeFileObjects.forEach(f => { if (f.url) urlsToFetch.push(f.url); });
      });
    });
  });
  console.log(`[Local] Found ${urlsToFetch.length} topper sheet URL references. Pre-fetching...`);
  const fetchedBuffers = await fetchUrlsInParallel(urlsToFetch, 10);

  const allIndexData = [];
  const allSummaryRows = [];

  for (const paperNode of targetPapers) {
    const includedIds = [];
    paperNode.topics.forEach(t => t.questions.forEach(q => { if (!excludedSet.has(q._id)) includedIds.push(q._id); }));

    if (isMultiPaper) {
      allIndexData.push({ type: 'unit', text: paperNode.paper, targetPageInternal: pdfDoc.getPageCount() });
    }

    const { indexData, summaryRows } = await renderPaperIntoDoc(
      pdfDoc, { fontBold, fontNormal, dhLogoImage, tw, th }, paperNode, includedIds, selections, fetchedBuffers
    );
    allIndexData.push(...indexData);
    allSummaryRows.push(...summaryRows);
  }

  // --- Table of Contents ---
  console.log('[Local] Generating Table of Contents...');
  const indexPdfDoc = await PDFDocument.create();
  let idxPage = indexPdfDoc.addPage();
  let idxY = idxPage.getSize().height - 80;

  idxPage.drawText(`TABLE OF CONTENTS`, { x: 50, y: idxY, size: 24, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
  idxY -= 50;

  const tableX = 50;
  const tableW = idxPage.getSize().width - 100;
  const rowH = 30;

  const tierConfig = {
    unit:     { indent: 0,  fontSize: 13, font: fontBold,   maxLen: 50 },
    section:  { indent: 10, fontSize: 11, font: fontBold,   maxLen: 55 },
    topic:    { indent: 25, fontSize: 10, font: fontBold,   maxLen: 58 },
    subtopic: { indent: 45, fontSize: 9,  font: fontNormal, maxLen: 60 }
  };
  let topicCounter = 0;

  idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.9, 0.9, 0.95) });
  idxPage.drawText(`Module Layout`, { x: tableX + 15, y: idxY + 10, size: 11, font: fontBold });
  idxPage.drawText(`PG`, { x: tableX + tableW - 40, y: idxY + 10, size: 11, font: fontBold });
  idxY -= rowH;

  for (let j = 0; j < allIndexData.length; j++) {
    const row = allIndexData[j];

    if (idxY < 50) {
      idxPage = indexPdfDoc.addPage();
      idxY = idxPage.getSize().height - 80;
      idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.9, 0.9, 0.95) });
      idxPage.drawText(`Module Layout (Cont.)`, { x: tableX + 15, y: idxY + 10, size: 11, font: fontBold });
      idxPage.drawText(`PG`, { x: tableX + tableW - 40, y: idxY + 10, size: 11, font: fontBold });
      idxY -= rowH;
    }

    if (row.type === 'unit' || row.type === 'section') topicCounter = 0;
    if (row.type === 'unit') {
      idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.15, 0.18, 0.32) });
    }

    const tier = tierConfig[row.type] || tierConfig.topic;
    let prefix = '';
    if (row.type === 'topic') { topicCounter += 1; prefix = `${topicCounter}) `; }
    else if (row.type === 'subtopic') prefix = '• ';

    let dText = sanitizeForPdf(prefix + row.text);
    if (dText.length > tier.maxLen) dText = dText.substring(0, tier.maxLen - 3) + '...';

    const textColor = row.type === 'unit' ? rgb(1, 1, 1) : rgb(0.1, 0.1, 0.2);
    idxPage.drawText(dText, { x: tableX + tier.indent, y: idxY + 10, size: tier.fontSize, font: tier.font, color: textColor });
    idxY -= rowH;
  }

  // --- Summary table ---
  console.log('[Local] Generating summary table...');
  const summaryPdfDoc = await PDFDocument.create();
  const topperMap = {};
  allSummaryRows.forEach(row => {
    row.toppers.forEach(t => {
      if (!topperMap[t.name]) topperMap[t.name] = { name: t.name, year: t.year || 'N/A', rank: t.rank || '', marks: t.marks || '', count: 0 };
      topperMap[t.name].count += 1;
    });
  });
  const topperSummaryTableRows = Object.values(topperMap)
    .sort((a, b) => b.count - a.count)
    .map((t, idx) => [String(idx + 1), t.name, t.year, t.rank, t.marks, String(t.count)]);

  drawPaginatedTable(
    summaryPdfDoc, fontBold, fontNormal, tw, th,
    'TOPPER PERFORMANCE SUMMARY',
    [
      { header: '#', width: (tw - 100) * 0.06 },
      { header: 'Topper Name', width: (tw - 100) * 0.32 },
      { header: 'Year', width: (tw - 100) * 0.12 },
      { header: 'Rank', width: (tw - 100) * 0.12 },
      { header: 'Marks', width: (tw - 100) * 0.13 },
      { header: 'Qs Answered', width: (tw - 100) * 0.25 }
    ],
    topperSummaryTableRows.length > 0 ? topperSummaryTableRows : [['-', 'No toppers selected for this book', '-', '-', '-', '-']]
  );

  const indexPages = await pdfDoc.copyPages(indexPdfDoc, indexPdfDoc.getPageIndices());
  const totalIndexPages = indexPages.length;
  for (let k = 0; k < totalIndexPages; k++) pdfDoc.insertPage(1 + k, indexPages[k]);

  const summaryPages = await pdfDoc.copyPages(summaryPdfDoc, summaryPdfDoc.getPageIndices());
  const totalSummaryPages = summaryPages.length;
  for (let k = 0; k < totalSummaryPages; k++) pdfDoc.insertPage(1 + totalIndexPages + k, summaryPages[k]);

  // TOC page-number back-fill
  let currentDataRow = 0;
  for (let k = 0; k < totalIndexPages; k++) {
    const injectedIdxPage = pdfDoc.getPage(1 + k);
    let drawY = k === 0 ? (injectedIdxPage.getSize().height - 130 - rowH) : (injectedIdxPage.getSize().height - 80 - rowH);
    while (currentDataRow < allIndexData.length && drawY >= 50) {
      const truePageNum = 1 + totalIndexPages + totalSummaryPages + allIndexData[currentDataRow].targetPageInternal;
      const numTier = tierConfig[allIndexData[currentDataRow].type] || tierConfig.topic;
      injectedIdxPage.drawText(`${truePageNum}`, { x: tableX + tableW - 40, y: drawY + 10, size: numTier.fontSize, font: numTier.font, color: rgb(0.1, 0.1, 0.1) });
      drawY -= rowH;
      currentDataRow++;
    }
  }

  // "Page X of Y" footer on every page except the cover (page 1).
  console.log('[Local] Stamping footer page numbers...');
  const totalPages = pdfDoc.getPageCount();
  for (let p = 1; p < totalPages; p++) {
    const pg = pdfDoc.getPage(p);
    const label = `Page ${p + 1} of ${totalPages}`;
    const labelW = fontNormal.widthOfTextAtSize(label, 8);
    pg.drawText(label, { x: (tw - labelW) / 2, y: 18, size: 8, font: fontNormal, color: rgb(0.55, 0.55, 0.6) });
  }

  console.log('[Local] Saving PDF bytes...');
  const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, pdfBytes);
  console.log(`[Local] Wrote ${outFile} (${pdfBytes.length} bytes, ${totalPages} pages).`);
  return { outFile, bytes: pdfBytes.length, pages: totalPages };
}

async function main() {
  const args = process.argv.slice(2);
  const getArgValue = (flag) => {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] ? args[index + 1] : null;
  };
  const getAllArgValues = (flag) => args.reduce((acc, a, i) => { if (a === flag && args[i + 1]) acc.push(args[i + 1]); return acc; }, []);

  const subjectSlug = getArgValue('--subject');
  const outFile = getArgValue('--out');
  const papers = getAllArgValues('--paper');

  if (!subjectSlug || !outFile) {
    console.error('Usage: node generateSubjectBookLocal.js --subject <slug> --out <file.pdf> [--paper "<paper name>" ...]');
    console.error('  (omit --paper to compile every unit for the subject into one combined book)');
    process.exit(1);
  }

  try {
    const result = await buildBook({ subjectSlug, papers, outFile });
    console.log('[Local] Done.', result);
    process.exit(0);
  } catch (err) {
    console.error('[Local] Fatal error:', err);
    process.exit(1);
  }
}

main();
