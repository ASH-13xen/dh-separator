import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { GridFSBucket } from 'mongodb';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { PsirBook } from '../models/PsirBook.js';

console.log('[Runner] Script loaded. Starting PDF generation pipeline...');
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

// Topper sheets are scanned documents; rasterizing them at a reduced DPI/JPEG quality
// before embedding shrinks the compiled book drastically vs. copying the original
// full-resolution scan pages.
const RASTER_DPI = 120;
const RASTER_QUALITY = 70;

// Rasterizes every page of a source PDF to a compressed JPEG buffer using pdftoppm
// (poppler-utils), returning one Buffer per page in order.
async function rasterizePdfToJpegs(pdfBuffer, dpi, quality) {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempPdfPath = path.join(os.tmpdir(), `psir-src-${uniqueId}.pdf`);
  const outPrefix = path.join(os.tmpdir(), `psir-out-${uniqueId}`);

  fs.writeFileSync(tempPdfPath, pdfBuffer);
  try {
    await execFileAsync('pdftoppm', ['-jpeg', '-r', String(dpi), '-jpegopt', `quality=${quality}`, tempPdfPath, outPrefix]);

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

// RFC 4180 compliant CSV Parser
function parseCSV(text) {
  const lines = [];
  let i = 0;
  const len = text.length;
  
  while (i < len) {
    const row = [];
    while (i < len) {
      let field = "";
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
      } else {
        // Unquoted field
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i];
          i++;
        }
      }
      row.push(field);
      
      if (i < len && text[i] === ',') {
        i++; // skip comma
      } else {
        // End of row
        if (i < len && text[i] === '\r') {
          i++;
          if (i < len && text[i] === '\n') {
            i++;
          }
        } else if (i < len && text[i] === '\n') {
          i++;
        }
        break;
      }
    }
    lines.push(row);
  }
  return lines;
}

function sanitizeForPdf(str) {
  if (!str) return "";
  return str
      .replace(/[\u201c\u201d]/g, '"') // smart double quotes
      .replace(/[\u2018\u2019]/g, "'") // smart single quotes
      .replace(/[\u2014\u2013]/g, '-') // dashes
      .replace(/\u00a0/g, ' ')         // non-breaking space
      .replace(/\u2026/g, '...')       // ellipsis
      .replace(/[^\x00-\xff]/g, '');   // strip anything else outside ISO-8859-1
}

// CSV exports from spreadsheets often store year as a decimal (e.g. "2023.00");
// strip a trailing .0/.00 so it reads as a plain year.
function cleanYear(str) {
  if (!str) return str;
  return str.replace(/\.0+$/, '');
}

// Draws a paginated table (with text-wrapped cells) onto a PDFDocument, adding pages as needed.
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
      // Hard-break any single token wider than the column so it can never bleed into
      // the next column (e.g. long names, joined topper lists, unspaced text).
      while (font.widthOfTextAtSize(word, size) > maxW) {
        if (current) {
          lines.push(current);
          current = '';
        }
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
        page.drawText(line, {
          x: lineX,
          y: y - (li + 1) * lineHeight + 1,
          size: 8,
          font: fontNormal,
          color: rgb(0.15, 0.15, 0.2)
        });
      });
      colX += col.width;
    });

    page.drawLine({
      start: { x: tableX, y: y - rowHeight },
      end: { x: tableX + tableW, y: y - rowHeight },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.85)
    });

    y -= rowHeight;
  });
}

async function fetchUrlsInParallel(urls, concurrencyLimit = 5) {
  const results = {};
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  console.log(`[Runner] [fetchUrlsInParallel] Total unique URLs to pre-fetch: ${uniqueUrls.length} (Concurrency limit: ${concurrencyLimit})`);
  
  for (let i = 0; i < uniqueUrls.length; i += concurrencyLimit) {
    const chunk = uniqueUrls.slice(i, i + concurrencyLimit);
    console.log(`[Runner] [fetchUrlsInParallel] Fetching chunk: ${i + 1} to ${Math.min(uniqueUrls.length, i + concurrencyLimit)}`);
    const promises = chunk.map(async (url) => {
      const cleanUrl = url.replace('https//', 'https://').replace('http//', 'http://');
      try {
        const res = await fetch(cleanUrl);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const buffer = await res.arrayBuffer();
        results[url] = buffer;
        console.log(`[Runner] [fetchUrlsInParallel] Successfully pre-fetched: ${cleanUrl} (${buffer.byteLength} bytes)`);
      } catch (err) {
        console.error(`[Runner] [fetchUrlsInParallel] Failed to pre-fetch URL: ${cleanUrl}`, err);
        results[url] = null;
      }
    });
    await Promise.all(promises);
  }
  return results;
}

const saveToGridFS = (db, buffer, filename) => {
  console.log(`[Runner] [saveToGridFS] Uploading '${filename}' to GridFS bucket 'psir_books'...`);
  return new Promise((resolve, reject) => {
    const bucket = new GridFSBucket(db, { bucketName: 'psir_books' });
    const uploadStream = bucket.openUploadStream(filename, { contentType: 'application/pdf' });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => {
      console.log(`[Runner] [saveToGridFS] Upload complete. File ID: ${uploadStream.id}`);
      resolve(uploadStream.id);
    });
    uploadStream.end(buffer);
  });
};

async function main() {
  console.log('[Runner] Parsing command-line CLI arguments...');
  const args = process.argv.slice(2);
  const getArgValue = (flag) => {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] ? args[index + 1] : null;
  };

  const paper = getArgValue('--paper');
  const jobId = getArgValue('--jobId');

  console.log(`[Runner] Extracted CLI arguments:`);
  console.log(`  - Paper: '${paper}'`);
  console.log(`  - Job ID: '${jobId}'`);

  if (!paper || !jobId) {
    console.error('[Runner] Error: --paper and --jobId are required arguments. Terminating execution.');
    process.exit(1);
  }

  // Connect to DB
  if (!process.env.MONGO_URI) {
    console.error('[Runner] MONGO_URI is missing from environment. Terminating execution.');
    process.exit(1);
  }

  console.log('[Runner] Connecting to MongoDB database...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[Runner] MongoDB connected successfully.');

  console.log(`[Runner] Querying database for job record ID: ${jobId}...`);
  const job = await PsirBook.findById(jobId);
  if (!job) {
    console.error(`[Runner] Error: PsirBook job not found in DB: ${jobId}. Terminating execution.`);
    process.exit(1);
  }

  // Retrieve selections and included question IDs directly from the database record
  const selections = job.selections || {};
  const includedQuestionIds = job.includedQuestionIds || [];
  const topicRenames = job.topicRenames || {};
  const topperOverrides = job.topperOverrides || {};
  const questionTextOverrides = job.questionTextOverrides || {};
  const titlePages = job.titlePages || {};
  console.log(`[Runner] Extracted inputs from database record:`);
  console.log(`  - Selections Count: ${Object.keys(selections).length}`);
  console.log(`  - Included Questions Count: ${includedQuestionIds.length}`);
  console.log(`  - Topic Renames: ${Object.keys(topicRenames).length}, Topper Overrides: ${Object.keys(topperOverrides).length}, Question Text Overrides: ${Object.keys(questionTextOverrides).length}, Title Pages: ${Object.keys(titlePages).length}`);

  try {
    console.log('[Runner] Updating job status in DB to "processing"...');
    job.status = 'processing';
    await job.save();
    console.log('[Runner] Job status saved as processing.');

    const csvPath = path.join(__dirname, '..', 'psir_questions_updated (2).csv');
    console.log(`[Runner] Looking for PSIR CSV database at path: ${csvPath}`);
    if (!fs.existsSync(csvPath)) {
      throw new Error(`PSIR questions CSV file not found at: ${csvPath}`);
    }
    
    console.log('[Runner] Reading CSV file contents...');
    const csvData = fs.readFileSync(csvPath, 'utf8');
    console.log('[Runner] Parsing CSV rows...');
    const parsed = parseCSV(csvData);
    const rows = parsed.slice(1);
    console.log(`[Runner] Total CSV rows parsed: ${rows.length}`);

    // Grouping mapping from ID to question details
    console.log(`[Runner] Filtering and grouping questions for paper '${paper}'...`);
    const questionsMap = {};
    // All rows for a given paper share the same section name in this CSV — capture it
    // once here instead of reading it off orderedQuestions[0], which would break if a
    // user-inserted title page (which has no real CSV section) ends up first.
    let csvSectionForPaper = null;

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
      const rowPaper = r[9].trim();

      if (!questionText || rowPaper !== paper) return;
      if (!csvSectionForPaper) csvSectionForPaper = section;

      const qKey = `${paper}||${section}||${topic}||${questionText}`;
      const qId = Buffer.from(qKey).toString('base64');
      
      if (!questionsMap[qId]) {
        questionsMap[qId] = {
          _id: qId,
          question_text: questionTextOverrides[qId] || questionText,
          paper: rowPaper,
          section: section,
          topic: topic,
          file_urls: []
        };
      }

      if (url) {
        const topperOverride = topperOverrides[url] || {};
        questionsMap[qId].file_urls.push({
          url: url,
          topper_name: topperOverride.topper_name || topperName || 'Unknown Topper',
          topper_year: cleanYear(topperOverride.topper_year || topperYear) || '',
          topper_rank: topperOverride.topper_rank || topperRank || '',
          topper_marks: topperOverride.topper_marks || topperMarks || ''
        });
      }
    });

    console.log(`[Runner] Found ${Object.keys(questionsMap).length} total questions belonging to '${paper}' in the CSV.`);

    // Get selected questions in order
    console.log('[Runner] Ordering selected questions...');
    const orderedQuestions = [];
    if (includedQuestionIds && Array.isArray(includedQuestionIds)) {
      includedQuestionIds.forEach(id => {
        if (questionsMap[id]) {
          orderedQuestions.push(questionsMap[id]);
        } else if (titlePages[id]) {
          orderedQuestions.push({
            _id: id,
            isTitlePage: true,
            subtitle: titlePages[id].subtitle,
            paper,
            section: csvSectionForPaper,
            topic: titlePages[id].topicKey,
            file_urls: []
          });
        }
      });
    } else {
      console.log('[Runner] No custom question ordering provided, falling back to database default order.');
      Object.values(questionsMap).forEach(q => orderedQuestions.push(q));
    }

    console.log(`[Runner] Total questions to include in the compiled book: ${orderedQuestions.length}`);
    if (orderedQuestions.length === 0) {
      throw new Error('No matched/selected questions found for this paper.');
    }

    // Structure selected questions hierarchically for PDF generation
    const docData = [];
    const sectionName = csvSectionForPaper || orderedQuestions[0].section;
    console.log(`[Runner] Formatting section structure. Section Name: '${sectionName}'`);

    const topicMap = {};
    orderedQuestions.forEach(q => {
      if (!topicMap[q.topic]) {
        topicMap[q.topic] = [];
      }
      topicMap[q.topic].push(q);
    });

    // Grouping key stays the raw CSV topic so grouping itself never shifts under a rename;
    // the rename is applied only to the displayed title. No re-sort here on purpose —
    // topicMap was populated by iterating the already-correctly-ordered orderedQuestions,
    // so Object.keys(topicMap) is already in the user's customized topic order. Sorting it
    // (as this used to do) silently discarded any topic reordering done in the editor.
    const topicsArray = Object.keys(topicMap).map(topicTitle => {
      return {
        title: topicRenames[topicTitle] || topicTitle,
        questions: topicMap[topicTitle]
      };
    });
    console.log(`[Runner] Grouped into ${topicsArray.length} topics (user's saved order/renames preserved).`);

    docData.push({
      section: sectionName,
      topics: topicsArray
    });

    // Pre-fetch topper PDFs concurrently
    console.log('[Runner] Compiling urls to pre-fetch...');
    const urlsToFetch = [];
    docData.forEach(secNode => {
      secNode.topics.forEach(topNode => {
        topNode.questions.forEach(item => {
          let activeFileObjects = [];
          if (item.file_urls && item.file_urls.length > 0) {
            if (selections && selections[item._id]) {
              const selectedUrls = Array.isArray(selections[item._id])
                ? selections[item._id]
                : [selections[item._id]];
              activeFileObjects = item.file_urls.filter(f => selectedUrls.includes(f.url));
            }
            if (activeFileObjects.length === 0 && item.file_urls.length > 0) {
              activeFileObjects = [item.file_urls[0]];
            }
          }
          activeFileObjects.forEach(f => {
            if (f.url) urlsToFetch.push(f.url);
          });
        });
      });
    });

    console.log(`[Runner] Found ${urlsToFetch.length} topper sheet URL references. Initiating pre-fetch...`);
    const fetchedBuffers = await fetchUrlsInParallel(urlsToFetch, 10);

    // 1. Initialize Master PDF Document
    console.log('[Runner] Initializing Master PDF Document via pdf-lib...');
    const pdfDoc = await PDFDocument.create();
    console.log('[Runner] Embedding fonts...');
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // 2. Create Premium Cover Page
    console.log('[Runner] Adding Cover Page...');
    const titlePage = pdfDoc.addPage();
    const { width: tw, height: th } = titlePage.getSize();
    
    // Background
    titlePage.drawRectangle({
        x: 0, y: 0, width: tw, height: th, color: rgb(0.98, 0.98, 0.99)
    });

    // Energetic Top Accent blocks
    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw, height: 180, color: rgb(0.12, 0.18, 0.35)
    });
    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw * 0.6, height: 10, color: rgb(0.96, 0.35, 0.14)
    });
    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw * 0.4, height: 10, color: rgb(0.25, 0.51, 0.96)
    });
    
    titlePage.drawText(`UPSC PSIR SERIES`, {
      x: 50, y: th - 85, size: 32, font: fontBold, color: rgb(1, 1, 1)
    });
    
    titlePage.drawText(`Political Science & International Relations (Optional)`, {
      x: 50, y: th - 125, size: 15, font: fontNormal, color: rgb(0.8, 0.8, 0.9)
    });

    // Title processing
    const paperTitle = sanitizeForPdf(`${paper}: ${sectionName}`);
    let fontSize = 32;
    let textWidth = fontBold.widthOfTextAtSize(paperTitle, fontSize);
    
    while (textWidth > tw - 80 && fontSize > 16) {
        fontSize -= 2;
        textWidth = fontBold.widthOfTextAtSize(paperTitle, fontSize);
    }
    
    titlePage.drawText(paper, {
      x: 50, y: th / 2 + 50, size: 40, font: fontBold, color: rgb(0.12, 0.18, 0.35)
    });

    titlePage.drawText(sanitizeForPdf(sectionName), {
      x: 50, y: th / 2 - 10, size: fontSize, font: fontBold, color: rgb(0.2, 0.2, 0.2)
    });

    // Energetic Bottom Accent
    titlePage.drawRectangle({
        x: 50, y: 150, width: tw - 100, height: 2, color: rgb(0.8, 0.8, 0.8)
    });
    titlePage.drawText(`AI-Structured Handwritten Answers Library`, {
      x: 50, y: 110, size: 14, font: fontNormal, color: rgb(0.4, 0.4, 0.4)
    });
    titlePage.drawText(`${new Date().getFullYear()} Edition`, {
      x: 50, y: 80, size: 14, font: fontBold, color: rgb(0.96, 0.35, 0.14)
    });

    const indexData = [];
    const summaryRows = [];

    // 3. Document Building
    console.log('[Runner] Starting core document building pass...');
    for (const secNode of docData) {
        console.log(`[Runner] Processing Section: ${secNode.section}`);
        indexData.push({
            type: 'section',
            text: `${paper} - ${secNode.section}`,
            targetPageInternal: pdfDoc.getPageCount()
        });

        // Section Divider Page
        const sPage = pdfDoc.addPage();
        sPage.drawRectangle({
            x: 0, y: 0, width: tw, height: th, color: rgb(0.12, 0.15, 0.28)
        });

        sPage.drawText("SECTION", {
            x: 50, y: th - 150, size: 24, font: fontNormal, color: rgb(0.7, 0.8, 0.95)
        });
        sPage.drawLine({
            start: { x: 50, y: th - 158 },
            end: { x: 50 + fontNormal.widthOfTextAtSize("SECTION", 24), y: th - 158 },
            thickness: 1.5,
            color: rgb(0.7, 0.8, 0.95)
        });

        let sY = th - 200;
        const sWords = sanitizeForPdf(`${paper}: ${secNode.section}`).toUpperCase().split(' ');
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

        // Topics
        for (const topNode of secNode.topics) {
            console.log(`  - Topic: ${topNode.title}`);
            indexData.push({
                type: 'topic',
                text: topNode.title,
                targetPageInternal: pdfDoc.getPageCount()
            });

            // Topic Divider Page
            const tPage = pdfDoc.addPage();
            tPage.drawRectangle({
                x: 0, y: 0, width: tw, height: th, color: rgb(0.18, 0.22, 0.35)
            });

            tPage.drawText("TOPIC", {
                x: 50, y: th - 150, size: 24, font: fontNormal, color: rgb(0.8, 0.85, 0.95)
            });
            tPage.drawLine({
                start: { x: 50, y: th - 158 },
                end: { x: 50 + fontNormal.widthOfTextAtSize("TOPIC", 24), y: th - 158 },
                thickness: 1.5,
                color: rgb(0.8, 0.85, 0.95)
            });

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

            // Questions
            for (let qIdx = 0; qIdx < topNode.questions.length; qIdx++) {
                const item = topNode.questions[qIdx];

                if (item.isTitlePage) {
                    console.log(`    * Subsection divider ${qIdx + 1}/${topNode.questions.length}: "${item.subtitle}"`);
                    indexData.push({
                        type: 'topic',
                        text: item.subtitle,
                        targetPageInternal: pdfDoc.getPageCount()
                    });

                    // Subsection Divider Page — same family as the Topic Divider above, but
                    // visually one level down (lighter background, smaller category label).
                    const dPage = pdfDoc.addPage();
                    const dBlue = rgb(0.07, 0.18, 0.62);
                    dPage.drawRectangle({
                        x: 0, y: 0, width: tw, height: th, color: rgb(1, 1, 1)
                    });
                    dPage.drawText("SUBTOPIC", {
                        x: 50, y: th - 140, size: 16, font: fontBold, color: dBlue
                    });
                    dPage.drawLine({
                        start: { x: 50, y: th - 148 },
                        end: { x: 50 + fontBold.widthOfTextAtSize("SUBTOPIC", 16), y: th - 148 },
                        thickness: 1.5,
                        color: dBlue
                    });
                    let dY = th - 190;
                    const dWords = sanitizeForPdf(item.subtitle).toUpperCase().split(' ');
                    let dLine = '';
                    for (const word of dWords) {
                        const testLine = dLine + word + ' ';
                        if (fontBold.widthOfTextAtSize(testLine, 20) > tw - 100) {
                            dPage.drawText(sanitizeForPdf(dLine), { x: 50, y: dY, size: 20, font: fontBold, color: dBlue });
                            dLine = word + ' ';
                            dY -= 26;
                        } else {
                            dLine = testLine;
                        }
                    }
                    dPage.drawText(sanitizeForPdf(dLine), { x: 50, y: dY, size: 20, font: fontBold, color: dBlue });
                    continue;
                }

                console.log(`    * Question ${qIdx + 1}/${topNode.questions.length}: ID='${item._id}'`);
                
                let activeFileObjects = [];
                if (item.file_urls && item.file_urls.length > 0) {
                     if (selections && selections[item._id]) {
                          const selectedUrls = Array.isArray(selections[item._id])
                              ? selections[item._id]
                              : [selections[item._id]];
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
                        if (w > maxW) {
                            lines.push(currentLine);
                            currentLine = word;
                        } else {
                            currentLine = testLine;
                        }
                    }
                    if (currentLine) lines.push(currentLine);
                    return lines;
                };

                const rawText = item.question_text || "Question text unavailable.";
                const prefixMatch = rawText.match(/^(?:Q\s*\d+|Q\.\s*\d+|Question\s*\d+)[.)\s:-]*/i);
                let cleanText = rawText;
                if (prefixMatch) {
                    cleanText = rawText.substring(prefixMatch[0].length).trim();
                }

                summaryRows.push({
                    topic: topNode.title,
                    questionText: cleanText,
                    toppers: activeFileObjects.map(f => ({
                        name: f.topper_name || 'Unknown Topper',
                        year: f.topper_year || '',
                        rank: f.topper_rank || '',
                        marks: f.topper_marks || ''
                    }))
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
                                // Embed first page with header overlay
                                const firstJpeg = await pdfDoc.embedJpg(jpegPages[0]);
                                const sw = firstJpeg.width;
                                const sh = firstJpeg.height;

                                const maxQWidth = tw - 60;
                                const qLines = wrapText(cleanText, 9, maxQWidth, fontNormal);
                                const maxVisibleLines = Math.min(qLines.length, 5);
                                
                                const highlightHeight = 40 + maxVisibleLines * 12;
                                const headerHeight = 15 + highlightHeight + 10;
                                
                                const newPage = pdfDoc.addPage([tw, th]);
                                
                                newPage.drawRectangle({
                                    x: 20,
                                    y: th - 15 - highlightHeight,
                                    width: tw - 40,
                                    height: highlightHeight,
                                    color: rgb(0.99, 0.96, 0.80)
                                });
                                
                                const tName = activeFileObj.topper_name || 'Unknown Topper';
                                const tYear = activeFileObj.topper_year || 'N/A';
                                const tRank = activeFileObj.topper_rank || 'N/A';
                                const tMarks = activeFileObj.topper_marks || 'N/A';
                                const topperTagStr = sanitizeForPdf(`${tName} (${tYear}, Rank ${tRank}, Marks ${tMarks})`);
                                
                                const tagWidth = fontBold.widthOfTextAtSize(topperTagStr, 10);
                                newPage.drawText(topperTagStr, {
                                    x: (tw - tagWidth) / 2,
                                    y: th - 30,
                                    size: 10,
                                    font: fontBold,
                                    color: rgb(0, 0, 0)
                                });
                                
                                let qTextY = th - 45;
                                const qLineHeight = 12;
                                for (let l = 0; l < maxVisibleLines; l++) {
                                    let line = qLines[l];
                                    if (l === maxVisibleLines - 1 && qLines.length > maxVisibleLines) {
                                        line += '...';
                                    }
                                    const lineW = fontNormal.widthOfTextAtSize(line, 9);
                                    newPage.drawText(line, {
                                        x: (tw - lineW) / 2,
                                        y: qTextY,
                                        size: 9,
                                        font: fontNormal,
                                        color: rgb(0, 0, 0)
                                    });
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

                                newPage.drawImage(firstJpeg, {
                                    x: drawX,
                                    y: drawY,
                                    width: drawWidth,
                                    height: drawHeight
                                });

                                // Add subsequent pages as plain full-bleed images
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
                                        subsequentPage.drawImage(pageJpeg, {
                                            x: pDrawX,
                                            y: pDrawY,
                                            width: pDrawWidth,
                                            height: pDrawHeight
                                        });
                                    }
                                }
                            } else {
                                throw new Error("Answer PDF contains no pages.");
                            }
                        } catch (pdfErr) {
                            console.error(`      Error appending PDF ${cloudUrl}:`, pdfErr);
                            // Error fallback page
                            const errPage = pdfDoc.addPage([tw, th]);
                            errPage.drawRectangle({
                                x: 0, y: 0, width: tw, height: th,
                                color: rgb(0.98, 0.95, 0.95)
                            });
                            
                            const maxQWidth = tw - 60;
                            const qLines = wrapText(cleanText, 9, maxQWidth, fontNormal);
                            const maxVisibleLines = Math.min(qLines.length, 5);
                            const highlightHeight = 40 + maxVisibleLines * 12;
                            
                            errPage.drawRectangle({
                                x: 20, y: th - 15 - highlightHeight, width: tw - 40, height: highlightHeight,
                                color: rgb(0.99, 0.96, 0.80)
                            });
                            
                            const tName = activeFileObj.topper_name || 'Unknown Topper';
                            const topperTagStr = `${tName} (ANSWER SHEET LOAD ERROR)`;
                            const tagWidth = fontBold.widthOfTextAtSize(topperTagStr, 10);
                            errPage.drawText(topperTagStr, {
                                x: (tw - tagWidth) / 2, y: th - 30, size: 10, font: fontBold, color: rgb(0.8, 0.2, 0.2)
                            });
                            
                            let qTextY = th - 45;
                            const qLineHeight = 12;
                            for (let l = 0; l < maxVisibleLines; l++) {
                                let line = qLines[l];
                                if (l === maxVisibleLines - 1 && qLines.length > maxVisibleLines) {
                                    line += '...';
                                }
                                const lineW = fontNormal.widthOfTextAtSize(line, 9);
                                errPage.drawText(line, {
                                    x: (tw - lineW) / 2, y: qTextY, size: 9, font: fontNormal, color: rgb(0, 0, 0)
                                });
                                qTextY -= qLineHeight;
                            }
                            
                            const warnY = th - 15 - highlightHeight - 120;
                            errPage.drawRectangle({
                                x: 40, y: warnY, width: tw - 80, height: 95,
                                color: rgb(1, 1, 1), borderColor: rgb(0.9, 0.7, 0.7), borderWidth: 1
                            });
                            
                            errPage.drawText("TEMPORARILY UNAVAILABLE", {
                                x: tw / 2 - 95, y: warnY + 65, size: 14, font: fontBold, color: rgb(0.8, 0.2, 0.2)
                            });
                            errPage.drawText("The system encountered an error trying to fetch or render this topper's response.", {
                                x: tw / 2 - 200, y: warnY + 40, size: 9, font: fontNormal, color: rgb(0.5, 0.3, 0.3)
                            });
                            errPage.drawText(`URL: ${cloudUrl}`, {
                                x: tw / 2 - 200, y: warnY + 20, size: 8, font: fontNormal, color: rgb(0.6, 0.6, 0.6)
                            });
                        }
                    }
                } else {
                    console.log('      No toppers selected for this question. Drawing placeholder page.');
                    const qPage = pdfDoc.addPage([tw, th]);
                    qPage.drawRectangle({
                        x: 0, y: 0, width: tw, height: th, color: rgb(0.97, 0.98, 0.99)
                    });
                    
                    const maxQWidth = tw - 60;
                    const qLines = wrapText(cleanText, 9, maxQWidth, fontNormal);
                    const maxVisibleLines = Math.min(qLines.length, 5);
                    const highlightHeight = 40 + maxVisibleLines * 12;
                    
                    qPage.drawRectangle({
                        x: 20, y: th - 15 - highlightHeight, width: tw - 40, height: highlightHeight,
                        color: rgb(0.99, 0.96, 0.80)
                    });
                    
                    const headerLabel = "NO TOPPER RESPONSE SELECTED";
                    const labelW = fontBold.widthOfTextAtSize(headerLabel, 10);
                    qPage.drawText(headerLabel, {
                        x: (tw - labelW) / 2, y: th - 30, size: 10, font: fontBold, color: rgb(0.8, 0.2, 0.2)
                    });
                    
                    let qTextY = th - 45;
                    const qLineHeight = 12;
                    for (let l = 0; l < maxVisibleLines; l++) {
                        let line = qLines[l];
                        if (l === maxVisibleLines - 1 && qLines.length > maxVisibleLines) {
                            line += '...';
                        }
                        const lineW = fontNormal.widthOfTextAtSize(line, 9);
                        qPage.drawText(line, {
                            x: (tw - lineW) / 2, y: qTextY, size: 9, font: fontNormal, color: rgb(0, 0, 0)
                        });
                        qTextY -= qLineHeight;
                    }
                    
                    const warnY = th - 15 - highlightHeight - 120;
                    qPage.drawRectangle({
                        x: 40, y: warnY, width: tw - 80, height: 95,
                        color: rgb(0.98, 0.94, 0.94), borderColor: rgb(0.9, 0.8, 0.8), borderWidth: 1
                    });
                    
                    qPage.drawText("INFORMATION NOT AVAILABLE", {
                        x: 55, y: warnY + 70, size: 9, font: fontBold, color: rgb(0.8, 0.2, 0.2)
                    });
                    qPage.drawText("No topper answer sheets are currently selected or uploaded for this question.", {
                        x: 55, y: warnY + 45, size: 11, font: fontBold, color: rgb(0.6, 0.2, 0.2)
                    });
                    qPage.drawText("Once a topper paper is linked and selected, the responses will be compiled directly following this layout page.", {
                        x: 55, y: warnY + 20, size: 8, font: fontNormal, color: rgb(0.5, 0.5, 0.6)
                    });
                }
            }
        }
    }

    // 4. Generate Table of Contents
    console.log('[Runner] Generating Table of Contents pages...');
    const indexPdfDoc = await PDFDocument.create();
    let idxPage = indexPdfDoc.addPage();
    let idxY = idxPage.getSize().height - 80;

    idxPage.drawText(`TABLE OF CONTENTS`, { x: 50, y: idxY, size: 24, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
    idxY -= 50;

    const tableX = 50;
    const tableW = idxPage.getSize().width - 100;
    const rowH = 30;
    
    idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.9, 0.9, 0.95) });
    idxPage.drawText(`Module Layout`, { x: tableX + 15, y: idxY + 10, size: 11, font: fontBold });
    idxPage.drawText(`PG`, { x: tableX + tableW - 40, y: idxY + 10, size: 11, font: fontBold });
    idxY -= rowH;

    for (let j = 0; j < indexData.length; j++) {
        const row = indexData[j];
        
        if (idxY < 50) {
             idxPage = indexPdfDoc.addPage();
             idxY = idxPage.getSize().height - 80;
             idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.9, 0.9, 0.95) });
             idxPage.drawText(`Module Layout (Cont.)`, { x: tableX + 15, y: idxY + 10, size: 11, font: fontBold });
             idxPage.drawText(`PG`, { x: tableX + tableW - 40, y: idxY + 10, size: 11, font: fontBold });
             idxY -= rowH;
        }

        const isSection = row.type === 'section';
        const indentX = isSection ? 10 : 30;
        const fontSize = isSection ? 11 : 9;
        const curFont = isSection ? fontBold : fontNormal;
        
        if (!isSection) {
            idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 1 });
        } else {
            idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.95, 0.97, 1.0), borderColor: rgb(0.7, 0.7, 0.8), borderWidth: 1 });
        }

        let dText = sanitizeForPdf(row.text);
        const maxLen = isSection ? 55 : 62;
        if (dText.length > maxLen) dText = dText.substring(0, maxLen - 3) + '...';
        
        idxPage.drawText(dText, { x: tableX + indentX, y: idxY + 10, size: fontSize, font: curFont, color: rgb(0.1, 0.1, 0.2) });
        idxY -= rowH;
    }

    // 5. Generate Summary Tables (Topper Performance Summary & Question-wise Topper Summary)
    console.log('[Runner] Generating summary table pages...');
    const summaryPdfDoc = await PDFDocument.create();

    const topperMap = {};
    summaryRows.forEach(row => {
        row.toppers.forEach(t => {
            if (!topperMap[t.name]) {
                topperMap[t.name] = { name: t.name, year: t.year || 'N/A', rank: t.rank || 'N/A', marks: t.marks || 'N/A', count: 0 };
            }
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

    console.log(`[Runner] Summary tables generated: ${summaryPdfDoc.getPageCount()} pages.`);

    console.log(`[Runner] Injecting ${indexPdfDoc.getPageCount()} Table of Contents pages into Master PDF...`);
    const indexPages = await pdfDoc.copyPages(indexPdfDoc, indexPdfDoc.getPageIndices());
    const totalIndexPages = indexPages.length;

    for (let k = 0; k < totalIndexPages; k++) {
        pdfDoc.insertPage(1 + k, indexPages[k]);
    }

    console.log(`[Runner] Injecting ${summaryPdfDoc.getPageCount()} Summary Table pages into Master PDF...`);
    const summaryPages = await pdfDoc.copyPages(summaryPdfDoc, summaryPdfDoc.getPageIndices());
    const totalSummaryPages = summaryPages.length;

    for (let k = 0; k < totalSummaryPages; k++) {
        pdfDoc.insertPage(1 + totalIndexPages + k, summaryPages[k]);
    }

    // Numbering pass
    console.log('[Runner] Performing page numbering calculations...');
    let currentDataRow = 0;
    for (let k = 0; k < totalIndexPages; k++) {
        const injectedIdxPage = pdfDoc.getPage(1 + k);
        let drawY = k === 0
           ? (injectedIdxPage.getSize().height - 130 - rowH)
           : (injectedIdxPage.getSize().height - 80 - rowH);

        while (currentDataRow < indexData.length && drawY >= 50) {
             const truePageNum = 1 + totalIndexPages + totalSummaryPages + indexData[currentDataRow].targetPageInternal;
             const isSec = indexData[currentDataRow].type === 'section';

             injectedIdxPage.drawText(`${truePageNum}`, {
                 x: tableX + tableW - 40,
                 y: drawY + 10,
                 size: isSec ? 11 : 9,
                 font: isSec ? fontBold : fontNormal,
                 color: rgb(0.1, 0.1, 0.1)
             });
             drawY -= rowH;
             currentDataRow++;
        }
    }

    console.log('[Runner] Saving final Master PDF bytes to memory...');
    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    console.log(`[Runner] PDF successfully built. File size: ${pdfBytes.length} bytes.`);

    // Update job status and store the compiled binary PDF directly in MongoDB
    const fileName = `PSIR_${paper.replace(/[^a-z0-9]/gi, '_')}_${jobId}.pdf`;
    const gridFsFileId = await saveToGridFS(mongoose.connection.db, Buffer.from(pdfBytes), fileName);

    console.log('[Runner] Saving GridFS file ID and status: "completed" to MongoDB...');
    job.status = 'completed';
    job.pdfFileId = gridFsFileId.toString();
    await job.save();
    console.log('[Runner] MongoDB update succeeded. Job completed.');

    console.log('[Runner] Script finished successfully. Exiting process with code 0.');
    process.exit(0);

  } catch (err) {
    console.error('[Runner] Severe Error occurred during runner execution:', err);
    job.status = 'failed';
    job.error = err.message;
    await job.save();
    console.log('[Runner] Database updated with status: failed and error logged.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[Runner] Unhandled runner script error:', err);
  process.exit(1);
});
