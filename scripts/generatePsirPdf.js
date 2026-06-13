import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { PsirBook } from '../models/PsirBook.js';

console.log('[Runner] Script loaded. Starting PDF generation pipeline...');
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('[Runner] Cloudinary initialization...');
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET 
});
console.log('[Runner] Cloudinary configured successfully.');

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

const uploadToCloudinary = (buffer, fileName) => {
  console.log(`[Runner] [uploadToCloudinary] Uploading buffer to Cloudinary as image/pdf. Folder: 'psir_books', public_id: ${fileName}`);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_chunked_stream(
      { 
        resource_type: 'image', 
        format: 'pdf',
        folder: 'psir_books', 
        public_id: fileName.replace('.pdf', ''), 
        chunk_size: 6000000 
      },
      (error, result) => {
        if (error) {
          console.error('[Runner] [uploadToCloudinary] Cloudinary upload stream error:', error);
          reject(error);
        } else if (result) {
          console.log(`[Runner] [uploadToCloudinary] Cloudinary upload successful. secure_url: ${result.secure_url}`);
          resolve(result.secure_url);
        }
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
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
  console.log(`[Runner] Extracted inputs from database record:`);
  console.log(`  - Selections Count: ${Object.keys(selections).length}`);
  console.log(`  - Included Questions Count: ${includedQuestionIds.length}`);

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
    
    rows.forEach(r => {
      if (r.length < 10) return;
      const section = r[0].trim();
      const topic = r[1].trim();
      const questionText = r[2].trim();
      const topperName = r[3].trim();
      const topperYear = r[4].trim();
      const topperRank = r[5].trim();
      const topperMarks = r[6].trim();
      const url = r[7].trim();
      const rowPaper = r[9].trim();
      
      if (!questionText || rowPaper !== paper) return;
      
      const qKey = `${paper}||${section}||${topic}||${questionText}`;
      const qId = Buffer.from(qKey).toString('base64');
      
      if (!questionsMap[qId]) {
        questionsMap[qId] = {
          _id: qId,
          question_text: questionText,
          paper: rowPaper,
          section: section,
          topic: topic,
          file_urls: []
        };
      }
      
      if (url) {
        questionsMap[qId].file_urls.push({
          url: url,
          topper_name: topperName || 'Unknown Topper',
          topper_year: topperYear || '',
          topper_rank: topperRank || '',
          topper_marks: topperMarks || ''
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
    const sectionName = orderedQuestions[0].section;
    console.log(`[Runner] Formatting section structure. Section Name: '${sectionName}'`);

    const topicMap = {};
    orderedQuestions.forEach(q => {
      if (!topicMap[q.topic]) {
        topicMap[q.topic] = [];
      }
      topicMap[q.topic].push(q);
    });

    const topicsArray = Object.keys(topicMap).map(topicTitle => {
      return {
        title: topicTitle,
        questions: topicMap[topicTitle]
      };
    });
    topicsArray.sort((a, b) => a.title.localeCompare(b.title));
    console.log(`[Runner] Grouped into ${topicsArray.length} sorted topics.`);

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

                if (activeFileObjects.length > 0) {
                    console.log(`      Found ${activeFileObjects.length} active topper sheets for this question.`);
                    for (const activeFileObj of activeFileObjects) {
                        const cloudUrl = activeFileObj.url.replace('https//', 'https://').replace('http//', 'http://');
                        console.log(`      Embedding topper note: ${activeFileObj.topper_name} (${cloudUrl})`);
                        try {
                            const arrayBuffer = fetchedBuffers[activeFileObj.url];
                            if (!arrayBuffer) throw new Error(`Buffer not found for pre-fetched URL: ${cloudUrl}`);
                            const sourcePdfDoc = await PDFDocument.load(arrayBuffer);
                            const sourcePageIndices = sourcePdfDoc.getPageIndices();
                            console.log(`      Loaded PDF document successfully. Total pages: ${sourcePageIndices.length}`);
                            
                            if (sourcePageIndices.length > 0) {
                                // Embed first page
                                const firstPage = sourcePdfDoc.getPage(0);
                                const { width: sw, height: sh } = firstPage.getSize();
                                
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
                                const topperTagStr = sanitizeForPdf(`Topper: ${tName} (${tYear}, Rank ${tRank})`);
                                
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
                                
                                const embeddedPage = await pdfDoc.embedPage(firstPage);
                                const remainingWidth = tw - 40;
                                const remainingHeight = th - headerHeight - 25;
                                
                                const scaleX = remainingWidth / sw;
                                const scaleY = remainingHeight / sh;
                                const scale = Math.min(scaleX, scaleY);
                                
                                const drawWidth = sw * scale;
                                const drawHeight = sh * scale;
                                
                                const drawX = 20 + (remainingWidth - drawWidth) / 2;
                                const drawY = 15 + (remainingHeight - drawHeight) / 2;
                                
                                newPage.drawPage(embeddedPage, {
                                    x: drawX,
                                    y: drawY,
                                    width: drawWidth,
                                    height: drawHeight
                                });
                                
                                // Add subsequent pages
                                const restPageIndices = sourcePageIndices.slice(1);
                                if (restPageIndices.length > 0) {
                                    console.log(`      Copying ${restPageIndices.length} subsequent pages...`);
                                    const sourcePages = await pdfDoc.copyPages(sourcePdfDoc, restPageIndices);
                                    sourcePages.forEach(p => pdfDoc.addPage(p));
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
                            const topperTagStr = `Topper: ${tName} (ANSWER SHEET LOAD ERROR)`;
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

    console.log(`[Runner] Injecting ${indexPdfDoc.getPageCount()} Table of Contents pages into Master PDF...`);
    const indexPages = await pdfDoc.copyPages(indexPdfDoc, indexPdfDoc.getPageIndices());
    const totalIndexPages = indexPages.length;
    
    for (let k = 0; k < totalIndexPages; k++) {
        pdfDoc.insertPage(1 + k, indexPages[k]);
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
             const truePageNum = 1 + totalIndexPages + indexData[currentDataRow].targetPageInternal;
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
    const pdfBytes = await pdfDoc.save();
    console.log(`[Runner] PDF successfully built. File size: ${pdfBytes.length} bytes.`);

    // Update job status and store the compiled binary PDF directly in MongoDB
    console.log('[Runner] Saving binary PDF data and status: "completed" to MongoDB...');
    job.status = 'completed';
    job.pdfData = Buffer.from(pdfBytes);
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
