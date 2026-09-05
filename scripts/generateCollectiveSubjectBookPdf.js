import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PDFDocument, rgb, StandardFonts, PDFString } from 'pdf-lib';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import { SubjectBook } from '../models/SubjectBook.js';
import { Subject } from '../models/Subject.js';
import { parseCSV } from '../utils/csv.js';

// Combined-book runner: compiles several papers ("units") of a subject into ONE book with one
// shared table of contents and one deduplicated topper summary page, with each unit's cover/
// section-divider/TOC text relabeled 1..N (per the job's precomputed `paperLabels`) instead of
// its real paper name. This is a parallel, standalone script — scripts/generateSubjectBookPdf.js
// (the per-unit "Generate Unit N Book" runner) is untouched and unaffected by anything here.
console.log('[CollectiveRunner] Script loaded. Starting combined-book PDF generation pipeline...');
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

// Same tuning as the per-unit runner — see that file for the sizing rationale.
const RASTER_DPI = 72;
const RASTER_QUALITY = 45;

async function rasterizePdfToJpegs(pdfBuffer, dpi, quality) {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempPdfPath = path.join(os.tmpdir(), `book-src-${uniqueId}.pdf`);
  const outPrefix = path.join(os.tmpdir(), `book-out-${uniqueId}`);

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

function cleanYear(str) {
  if (!str) return str;
  return str.replace(/\.0+$/, '');
}

function addLinkAnnotation(doc, page, { x, y, width, height, url }) {
  const linkAnnotRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, y, x + width, y + height],
      Border: [0, 0, 0],
      A: {
        Type: 'Action',
        S: 'URI',
        URI: PDFString.of(url)
      }
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
  console.log(`[CollectiveRunner] [fetchUrlsInParallel] Total unique URLs to pre-fetch: ${uniqueUrls.length} (Concurrency limit: ${concurrencyLimit})`);

  for (let i = 0; i < uniqueUrls.length; i += concurrencyLimit) {
    const chunk = uniqueUrls.slice(i, i + concurrencyLimit);
    const promises = chunk.map(async (url) => {
      const cleanUrl = url.replace('https//', 'https://').replace('http//', 'http://');
      try {
        const res = await fetch(cleanUrl);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const buffer = await res.arrayBuffer();
        results[url] = buffer;
      } catch (err) {
        console.error(`[CollectiveRunner] [fetchUrlsInParallel] Failed to pre-fetch URL: ${cleanUrl}`, err);
        results[url] = null;
      }
    });
    await Promise.all(promises);
  }
  return results;
}

const uploadPdfToCloudinary = (buffer, publicId) => {
  console.log(`[CollectiveRunner] [uploadPdfToCloudinary] Uploading '${publicId}' to Cloudinary...`);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: 'compiled_books', public_id: publicId },
      (error, result) => {
        if (result) {
          console.log(`[CollectiveRunner] [uploadPdfToCloudinary] Upload complete: ${result.secure_url}`);
          resolve(result);
        } else {
          reject(error);
        }
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
};

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

async function main() {
  console.log('[CollectiveRunner] Parsing command-line CLI arguments...');
  const args = process.argv.slice(2);
  const getArgValue = (flag) => {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] ? args[index + 1] : null;
  };

  const subjectSlug = getArgValue('--subject');
  const jobId = getArgValue('--jobId');

  console.log(`[CollectiveRunner] Extracted CLI arguments: Subject='${subjectSlug}', Job ID='${jobId}'`);

  if (!subjectSlug || !jobId) {
    console.error('[CollectiveRunner] Error: --subject and --jobId are required arguments. Terminating execution.');
    process.exit(1);
  }

  if (!process.env.MONGO_URI) {
    console.error('[CollectiveRunner] MONGO_URI is missing from environment. Terminating execution.');
    process.exit(1);
  }
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('[CollectiveRunner] CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET are missing from environment. Terminating execution.');
    process.exit(1);
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  console.log('[CollectiveRunner] Connecting to MongoDB database...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[CollectiveRunner] MongoDB connected successfully.');

  const subjectDoc = await Subject.findOne({ slug: subjectSlug });
  if (!subjectDoc || !subjectDoc.csvData) {
    console.error(`[CollectiveRunner] Error: Subject not found or has no classified questions: ${subjectSlug}. Terminating execution.`);
    process.exit(1);
  }

  const job = await SubjectBook.findById(jobId);
  if (!job) {
    console.error(`[CollectiveRunner] Error: SubjectBook job not found in DB: ${jobId}. Terminating execution.`);
    process.exit(1);
  }

  const paperJobs = job.paperJobs || [];
  if (paperJobs.length === 0) {
    console.error('[CollectiveRunner] Error: Job record has no paperJobs. Terminating execution.');
    job.status = 'failed';
    job.error = 'No units were recorded on this combined-book job.';
    await job.save();
    process.exit(1);
  }
  console.log(`[CollectiveRunner] Job carries ${paperJobs.length} unit(s): ${paperJobs.map(p => `${p.paper} -> "${p.label}"`).join(', ')}`);

  try {
    job.status = 'processing';
    await job.save();

    const csvData = subjectDoc.csvData;
    const parsed = parseCSV(csvData);
    const rows = parsed.slice(1);
    console.log(`[CollectiveRunner] Total CSV rows parsed: ${rows.length}`);

    // Merge every selected unit's saved overrides up front so a single shared questionsMap
    // (spanning the whole subject, same as the per-unit runner) can apply the right override
    // regardless of which unit a question's row actually belongs to.
    const mergedQuestionTextOverrides = {};
    const mergedTopperOverrides = {};
    const mergedTitlePages = {};
    paperJobs.forEach(pj => {
      Object.assign(mergedQuestionTextOverrides, pj.questionTextOverrides || {});
      Object.assign(mergedTopperOverrides, pj.topperOverrides || {});
      Object.assign(mergedTitlePages, pj.titlePages || {});
    });

    console.log('[CollectiveRunner] Building question lookup across the whole subject...');
    const questionsMap = {};
    const csvSectionByPaper = {};

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

      if (!questionText || !rowPaper) return;
      if (!csvSectionByPaper[rowPaper]) csvSectionByPaper[rowPaper] = section;

      const qKey = `${rowPaper}||${section}||${topic}||${questionText}`;
      const qId = Buffer.from(qKey).toString('base64');

      if (!questionsMap[qId]) {
        questionsMap[qId] = {
          _id: qId,
          question_text: mergedQuestionTextOverrides[qId] || questionText,
          paper: rowPaper,
          section: section,
          topic: topic,
          file_urls: []
        };
      }

      if (url) {
        const topperOverride = mergedTopperOverrides[url] || {};
        questionsMap[qId].file_urls.push({
          url: url,
          topper_name: topperOverride.topper_name || topperName || 'Unknown Topper',
          topper_year: cleanYear(topperOverride.topper_year || topperYear) || '',
          topper_rank: topperOverride.topper_rank || topperRank || '',
          topper_marks: topperOverride.topper_marks || topperMarks || ''
        });
      }
    });

    console.log(`[CollectiveRunner] Found ${Object.keys(questionsMap).length} total question(s) across the whole subject.`);

    // Build one docData entry per selected unit — each keeps its own topic grouping, but all
    // entries feed into the SAME indexData/summaryRows arrays below, which is what naturally
    // gives the finished book one shared table of contents and one deduplicated topper page.
    const docData = [];
    for (const pj of paperJobs) {
      const { paper: realPaper, label, selections, includedQuestionIds, topicRenames, questionOrder } = pj;

      const idToTopicKey = {};
      Object.entries(questionOrder || {}).forEach(([topicKey, ids]) => {
        (ids || []).forEach(id => { idToTopicKey[id] = topicKey; });
      });

      const orderedQuestions = [];
      (includedQuestionIds || []).forEach(id => {
        if (questionsMap[id]) {
          orderedQuestions.push(questionsMap[id]);
        } else if (mergedTitlePages[id]) {
          orderedQuestions.push({
            _id: id,
            isTitlePage: true,
            subtitle: mergedTitlePages[id].subtitle,
            paper: realPaper,
            section: csvSectionByPaper[realPaper],
            topic: mergedTitlePages[id].topicKey,
            file_urls: []
          });
        }
      });

      if (orderedQuestions.length === 0) {
        console.warn(`[CollectiveRunner] Unit '${realPaper}' (label "${label}") resolved to zero questions — skipping.`);
        continue;
      }

      const sectionName = csvSectionByPaper[realPaper] || orderedQuestions[0].section;
      const topicMap = {};
      orderedQuestions.forEach(q => {
        const topicKey = idToTopicKey[q._id] || q.topic;
        if (!topicMap[topicKey]) topicMap[topicKey] = [];
        topicMap[topicKey].push(q);
      });

      const topicsArray = Object.keys(topicMap).map(topicTitle => ({
        title: (topicRenames || {})[topicTitle] || topicTitle,
        questions: topicMap[topicTitle]
      }));

      docData.push({
        label,
        realPaper,
        section: sectionName,
        selections: selections || {},
        topics: topicsArray
      });
      console.log(`[CollectiveRunner] Unit '${realPaper}' -> "${label}": ${topicsArray.length} topic(s), ${orderedQuestions.length} question(s).`);
    }

    if (docData.length === 0) {
      throw new Error('None of the selected units resolved to any questions.');
    }

    // Pre-fetch topper PDFs concurrently, across every unit at once.
    console.log('[CollectiveRunner] Compiling urls to pre-fetch...');
    const urlsToFetch = [];
    docData.forEach(secNode => {
      secNode.topics.forEach(topNode => {
        topNode.questions.forEach(item => {
          let activeFileObjects = [];
          if (item.file_urls && item.file_urls.length > 0) {
            if (secNode.selections && secNode.selections[item._id]) {
              const selectedUrls = Array.isArray(secNode.selections[item._id])
                ? secNode.selections[item._id]
                : [secNode.selections[item._id]];
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

    console.log(`[CollectiveRunner] Found ${urlsToFetch.length} topper sheet URL references. Initiating pre-fetch...`);
    const fetchedBuffers = await fetchUrlsInParallel(urlsToFetch, 10);

    console.log('[CollectiveRunner] Initializing Master PDF Document via pdf-lib...');
    const pdfDoc = await PDFDocument.create();
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const dhLogoImage = await pdfDoc.embedJpg(fs.readFileSync(path.join(__dirname, '..', 'dhlogo.jpg')));

    // Single cover page for the whole combined book — deliberately generic (unit count only,
    // never the real unit numbers), matching the same anonymization as the internal relabeling.
    console.log('[CollectiveRunner] Adding Cover Page...');
    const titlePage = pdfDoc.addPage();
    const { width: tw, height: th } = titlePage.getSize();

    titlePage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(0.98, 0.98, 0.99) });
    titlePage.drawRectangle({ x: 0, y: th - 180, width: tw, height: 180, color: rgb(0.12, 0.18, 0.35) });
    titlePage.drawRectangle({ x: 0, y: th - 180, width: tw * 0.6, height: 10, color: rgb(0.96, 0.35, 0.14) });
    titlePage.drawRectangle({ x: 0, y: th - 180, width: tw * 0.4, height: 10, color: rgb(0.25, 0.51, 0.96) });

    titlePage.drawText(sanitizeForPdf(`${subjectDoc.name.toUpperCase()} SERIES`), {
      x: 50, y: th - 85, size: 32, font: fontBold, color: rgb(1, 1, 1)
    });
    titlePage.drawText(sanitizeForPdf(subjectDoc.name), {
      x: 50, y: th - 125, size: 15, font: fontNormal, color: rgb(0.8, 0.8, 0.9)
    });

    titlePage.drawText('Combined Book', {
      x: 50, y: th / 2 + 50, size: 40, font: fontBold, color: rgb(0.12, 0.18, 0.35)
    });
    titlePage.drawText(`${docData.length} Unit${docData.length !== 1 ? 's' : ''} Combined`, {
      x: 50, y: th / 2 - 10, size: 24, font: fontBold, color: rgb(0.2, 0.2, 0.2)
    });

    titlePage.drawRectangle({ x: 50, y: 150, width: tw - 100, height: 2, color: rgb(0.8, 0.8, 0.8) });
    titlePage.drawText(`AI-Structured Handwritten Answers Library`, {
      x: 50, y: 110, size: 14, font: fontNormal, color: rgb(0.4, 0.4, 0.4)
    });
    titlePage.drawText(`${new Date().getFullYear()} Edition`, {
      x: 50, y: 80, size: 14, font: fontBold, color: rgb(0.96, 0.35, 0.14)
    });

    const indexData = [];
    const summaryRows = [];

    console.log('[CollectiveRunner] Starting core document building pass...');
    for (const secNode of docData) {
        console.log(`[CollectiveRunner] Processing Unit: ${secNode.label}`);
        indexData.push({
            type: 'section',
            text: `${secNode.label} - ${secNode.section}`,
            targetPageInternal: pdfDoc.getPageCount()
        });

        const sPage = pdfDoc.addPage();
        sPage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(0.12, 0.15, 0.28) });

        sPage.drawText("SECTION", { x: 50, y: th - 150, size: 24, font: fontNormal, color: rgb(0.7, 0.8, 0.95) });
        sPage.drawLine({
            start: { x: 50, y: th - 158 },
            end: { x: 50 + fontNormal.widthOfTextAtSize("SECTION", 24), y: th - 158 },
            thickness: 1.5, color: rgb(0.7, 0.8, 0.95)
        });

        let sY = th - 200;
        const sWords = sanitizeForPdf(`${secNode.label}: ${secNode.section}`).toUpperCase().split(' ');
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

        for (const topNode of secNode.topics) {
            console.log(`  - Topic: ${topNode.title}`);
            indexData.push({
                type: 'topic',
                text: topNode.title,
                targetPageInternal: pdfDoc.getPageCount()
            });

            const tPage = pdfDoc.addPage();
            tPage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(0.18, 0.22, 0.35) });

            tPage.drawText("TOPIC", { x: 50, y: th - 150, size: 24, font: fontNormal, color: rgb(0.8, 0.85, 0.95) });
            tPage.drawLine({
                start: { x: 50, y: th - 158 },
                end: { x: 50 + fontNormal.widthOfTextAtSize("TOPIC", 24), y: th - 158 },
                thickness: 1.5, color: rgb(0.8, 0.85, 0.95)
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

            for (let qIdx = 0; qIdx < topNode.questions.length; qIdx++) {
                const item = topNode.questions[qIdx];

                if (item.isTitlePage) {
                    console.log(`    * Subsection divider ${qIdx + 1}/${topNode.questions.length}: "${item.subtitle}"`);
                    indexData.push({
                        type: 'subtopic',
                        text: item.subtitle,
                        targetPageInternal: pdfDoc.getPageCount()
                    });

                    const dPage = pdfDoc.addPage();
                    const dBlue = rgb(0.07, 0.18, 0.62);
                    dPage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(1, 1, 1) });

                    const wmSize = 300;
                    dPage.drawImage(dhLogoImage, {
                        x: (tw - wmSize) / 2, y: (th - wmSize) / 2,
                        width: wmSize, height: wmSize, opacity: 0.1
                    });

                    dPage.drawText("SUB-TOPIC", { x: 50, y: th - 140, size: 20, font: fontBold, color: dBlue });
                    dPage.drawLine({
                        start: { x: 50, y: th - 150 },
                        end: { x: 50 + fontBold.widthOfTextAtSize("SUB-TOPIC", 20), y: th - 150 },
                        thickness: 1.5, color: dBlue
                    });
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
                    addLinkAnnotation(pdfDoc, dPage, {
                        x: 50, y: footerY - 2, width: websiteWidth, height: footerSize + 4,
                        url: 'https://www.darkhorseupsc.com'
                    });

                    const telegramText = "Telegram: https://t.me/darkhorsecse";
                    const telegramWidth = fontNormal.widthOfTextAtSize(telegramText, footerSize);
                    dPage.drawText(telegramText, {
                        x: tw - 50 - telegramWidth, y: footerY, size: footerSize, font: fontNormal, color: rgb(0.4, 0.4, 0.4)
                    });
                    addLinkAnnotation(pdfDoc, dPage, {
                        x: tw - 50 - telegramWidth, y: footerY - 2, width: telegramWidth, height: footerSize + 4,
                        url: 'https://t.me/darkhorsecse'
                    });

                    continue;
                }

                console.log(`    * Question ${qIdx + 1}/${topNode.questions.length}: ID='${item._id}'`);

                let activeFileObjects = [];
                if (item.file_urls && item.file_urls.length > 0) {
                     if (secNode.selections && secNode.selections[item._id]) {
                          const selectedUrls = Array.isArray(secNode.selections[item._id])
                              ? secNode.selections[item._id]
                              : [secNode.selections[item._id]];
                          activeFileObjects = item.file_urls.filter(f => selectedUrls.includes(f.url));
                     }
                     if (activeFileObjects.length === 0 && item.file_urls.length > 0) {
                          activeFileObjects = [item.file_urls[0]];
                     }
                }

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
                                    x: 20, y: th - 15 - highlightHeight, width: tw - 40, height: highlightHeight,
                                    color: rgb(0.99, 0.96, 0.80)
                                });

                                const tName = activeFileObj.topper_name || 'Unknown Topper';
                                const tYear = activeFileObj.topper_year || 'N/A';
                                const tagMetaParts = [tYear];
                                if (activeFileObj.topper_rank) tagMetaParts.push(`Rank ${activeFileObj.topper_rank}`);
                                if (activeFileObj.topper_marks) tagMetaParts.push(`Marks ${activeFileObj.topper_marks}`);
                                const topperTagStr = sanitizeForPdf(`${tName} (${tagMetaParts.join(', ')})`);

                                const tagWidth = fontBold.widthOfTextAtSize(topperTagStr, 10);
                                newPage.drawText(topperTagStr, {
                                    x: (tw - tagWidth) / 2, y: th - 30, size: 10, font: fontBold, color: rgb(0, 0, 0)
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
                                        x: (tw - lineW) / 2, y: qTextY, size: 9, font: fontNormal, color: rgb(0, 0, 0)
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
                    qPage.drawRectangle({ x: 0, y: 0, width: tw, height: th, color: rgb(0.97, 0.98, 0.99) });

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

    // Table of Contents — one pass, over the combined indexData, so it's automatically a
    // single shared index spanning every selected unit.
    console.log('[CollectiveRunner] Generating Table of Contents pages...');
    const indexPdfDoc = await PDFDocument.create();
    let idxPage = indexPdfDoc.addPage();
    let idxY = idxPage.getSize().height - 80;

    idxPage.drawText(`TABLE OF CONTENTS`, { x: 50, y: idxY, size: 24, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
    idxY -= 50;

    const tableX = 50;
    const tableW = idxPage.getSize().width - 100;
    const rowH = 30;

    const tierConfig = {
        section:  { indent: 10, fontSize: 11, font: fontBold,   maxLen: 55 },
        topic:    { indent: 25, fontSize: 10, font: fontBold,   maxLen: 58 },
        subtopic: { indent: 45, fontSize: 9,  font: fontNormal, maxLen: 60 }
    };
    let topicCounter = 0;

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

        if (row.type === 'section') topicCounter = 0;

        const tier = tierConfig[row.type] || tierConfig.topic;
        let prefix = '';
        if (row.type === 'topic') {
            topicCounter += 1;
            prefix = `${topicCounter}) `;
        } else if (row.type === 'subtopic') {
            prefix = '• ';
        }

        let dText = sanitizeForPdf(prefix + row.text);
        if (dText.length > tier.maxLen) dText = dText.substring(0, tier.maxLen - 3) + '...';

        idxPage.drawText(dText, { x: tableX + tier.indent, y: idxY + 10, size: tier.fontSize, font: tier.font, color: rgb(0.1, 0.1, 0.2) });
        idxY -= rowH;
    }

    // Topper summary — one pass over every unit's summaryRows, keyed by name, so a topper who
    // appears in more than one selected unit is listed exactly once here.
    console.log('[CollectiveRunner] Generating summary table pages...');
    const summaryPdfDoc = await PDFDocument.create();

    const topperMap = {};
    summaryRows.forEach(row => {
        row.toppers.forEach(t => {
            if (!topperMap[t.name]) {
                topperMap[t.name] = { name: t.name, year: t.year || 'N/A', rank: t.rank || '', marks: t.marks || '', count: 0 };
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

    console.log(`[CollectiveRunner] Summary tables generated: ${summaryPdfDoc.getPageCount()} pages.`);

    console.log(`[CollectiveRunner] Injecting ${indexPdfDoc.getPageCount()} Table of Contents pages into Master PDF...`);
    const indexPages = await pdfDoc.copyPages(indexPdfDoc, indexPdfDoc.getPageIndices());
    const totalIndexPages = indexPages.length;

    for (let k = 0; k < totalIndexPages; k++) {
        pdfDoc.insertPage(1 + k, indexPages[k]);
    }

    console.log(`[CollectiveRunner] Injecting ${summaryPdfDoc.getPageCount()} Summary Table pages into Master PDF...`);
    const summaryPages = await pdfDoc.copyPages(summaryPdfDoc, summaryPdfDoc.getPageIndices());
    const totalSummaryPages = summaryPages.length;

    for (let k = 0; k < totalSummaryPages; k++) {
        pdfDoc.insertPage(1 + totalIndexPages + k, summaryPages[k]);
    }

    console.log('[CollectiveRunner] Performing page numbering calculations...');
    let currentDataRow = 0;
    for (let k = 0; k < totalIndexPages; k++) {
        const injectedIdxPage = pdfDoc.getPage(1 + k);
        let drawY = k === 0
           ? (injectedIdxPage.getSize().height - 130 - rowH)
           : (injectedIdxPage.getSize().height - 80 - rowH);

        while (currentDataRow < indexData.length && drawY >= 50) {
             const truePageNum = 1 + totalIndexPages + totalSummaryPages + indexData[currentDataRow].targetPageInternal;
             const numTier = tierConfig[indexData[currentDataRow].type] || tierConfig.topic;

             injectedIdxPage.drawText(`${truePageNum}`, {
                 x: tableX + tableW - 40,
                 y: drawY + 10,
                 size: numTier.fontSize,
                 font: numTier.font,
                 color: rgb(0.1, 0.1, 0.1)
             });
             drawY -= rowH;
             currentDataRow++;
        }
    }

    console.log('[CollectiveRunner] Saving final Master PDF bytes to memory...');
    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    console.log(`[CollectiveRunner] PDF successfully built. File size: ${pdfBytes.length} bytes.`);

    const fileName = `${subjectSlug}_Combined_${docData.length}Units_${jobId}`;
    const uploadResult = await uploadPdfToCloudinary(Buffer.from(pdfBytes), fileName);

    job.status = 'completed';
    job.pdfUrl = uploadResult.secure_url;
    job.pdfPublicId = uploadResult.public_id;
    await job.save();
    console.log('[CollectiveRunner] MongoDB update succeeded. Job completed.');

    process.exit(0);

  } catch (err) {
    console.error('[CollectiveRunner] Severe Error occurred during runner execution:', err);
    job.status = 'failed';
    job.error = err.message;
    await job.save();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[CollectiveRunner] Unhandled runner script error:', err);
  process.exit(1);
});
