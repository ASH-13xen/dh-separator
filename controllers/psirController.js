import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
        console.error(`Failed to pre-fetch URL: ${cleanUrl}`, err);
        results[url] = null;
      }
    });
    await Promise.all(promises);
  }
  return results;
}

export const previewPsirData = async (req, res) => {
  try {
    const csvPath = path.join(process.cwd(), 'psir_questions_updated (2).csv');
    if (!fs.existsSync(csvPath)) {
      return res.status(404).json({ error: 'PSIR questions CSV file not found.' });
    }
    
    const csvData = fs.readFileSync(csvPath, 'utf8');
    const parsed = parseCSV(csvData);
    const rows = parsed.slice(1); // skip headers
    
    const hierarchy = {};
    
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
      const paper = r[9].trim();
      
      if (!questionText || !paper) return;
      
      if (!hierarchy[paper]) {
        hierarchy[paper] = {
          paper: paper,
          section: section,
          topics: {}
        };
      }
      
      const paperObj = hierarchy[paper];
      if (!paperObj.topics[topic]) {
        paperObj.topics[topic] = {
          title: topic,
          questions: {}
        };
      }
      
      const topicObj = paperObj.topics[topic];
      const qKey = `${paper}||${section}||${topic}||${questionText}`;
      if (!topicObj.questions[qKey]) {
        topicObj.questions[qKey] = {
          _id: Buffer.from(qKey).toString('base64'),
          question_text: questionText,
          file_urls: []
        };
      }
      
      if (url) {
        topicObj.questions[qKey].file_urls.push({
          url: url,
          topper_name: topperName || 'Unknown Topper',
          topper_year: topperYear || '',
          topper_rank: topperRank || '',
          topper_marks: topperMarks || ''
        });
      }
    });
    
    const result = Object.values(hierarchy).map(paperObj => {
      const topicsArray = Object.values(paperObj.topics).map(topObj => {
        const questionsArray = Object.values(topObj.questions);
        return {
          title: topObj.title,
          questions: questionsArray
        };
      });
      
      topicsArray.sort((a, b) => a.title.localeCompare(b.title));
      
      return {
        paper: paperObj.paper,
        section: paperObj.section,
        topics: topicsArray
      };
    });
    
    const paperOrder = { 'Paper 1A': 1, 'Paper 1B': 2, 'Paper 2A': 3, 'Paper 2B': 4 };
    result.sort((a, b) => {
      const orderA = paperOrder[a.paper] || 99;
      const orderB = paperOrder[b.paper] || 99;
      return orderA - orderB;
    });
    
    res.json(result);
  } catch (err) {
    console.error('[PsirController] Preview error:', err);
    res.status(500).json({ error: 'Failed to parse and group PSIR questions.', details: err.message });
  }
};

export const generatePsirPdf = async (req, res) => {
  try {
    const { paper, selections, includedQuestionIds } = req.body;

    if (!paper) {
      return res.status(400).json({ error: 'Paper name is required to generate PDF.' });
    }

    const csvPath = path.join(process.cwd(), 'psir_questions_updated (2).csv');
    if (!fs.existsSync(csvPath)) {
      return res.status(404).json({ error: 'PSIR questions CSV file not found.' });
    }
    
    const csvData = fs.readFileSync(csvPath, 'utf8');
    const parsed = parseCSV(csvData);
    const rows = parsed.slice(1);

    // Grouping mapping from ID to question details
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

    // Get selected questions in order
    const orderedQuestions = [];
    if (includedQuestionIds && Array.isArray(includedQuestionIds)) {
      includedQuestionIds.forEach(id => {
        if (questionsMap[id]) {
          orderedQuestions.push(questionsMap[id]);
        }
      });
    } else {
      // Default fallback: include all questions belonging to this paper
      Object.values(questionsMap).forEach(q => orderedQuestions.push(q));
    }

    if (orderedQuestions.length === 0) {
      return res.status(404).json({ error: 'No matched/selected questions found for this paper.' });
    }

    // Structure selected questions hierarchically for PDF generation
    const docData = [];
    const sectionName = orderedQuestions[0].section; // Paper has only 1 section in this CSV mapping

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
    // Sort topics alphabetically to keep a clean structure
    topicsArray.sort((a, b) => a.title.localeCompare(b.title));

    docData.push({
      section: sectionName,
      topics: topicsArray
    });

    // Pre-fetch topper PDFs concurrently to avoid sequential timeouts and network delays
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

    console.log(`[PsirController] Pre-fetching ${urlsToFetch.length} topper answer PDFs in parallel...`);
    const fetchedBuffers = await fetchUrlsInParallel(urlsToFetch, 10);

    // 1. Initialize Master PDF Document
    const pdfDoc = await PDFDocument.create();
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // 2. Create Premium Cover Page
    const titlePage = pdfDoc.addPage();
    const { width: tw, height: th } = titlePage.getSize();
    
    // Background
    titlePage.drawRectangle({
        x: 0, y: 0, width: tw, height: th, color: rgb(0.98, 0.98, 0.99)
    });

    // Energetic Top Accent blocks
    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw, height: 180, color: rgb(0.12, 0.18, 0.35) // Elegant Navy
    });
    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw * 0.6, height: 10, color: rgb(0.96, 0.35, 0.14) // Vibrant Orange
    });
    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw * 0.4, height: 10, color: rgb(0.25, 0.51, 0.96) // Vibrant Blue
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
    
    // Auto-scale text down if too wide
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

    const indexData = []; // { type: 'section'|'topic', text: "...", targetPageInternal: X }

    // 3. Document Building
    for (const secNode of docData) {
        // Record Section in Index
        indexData.push({
            type: 'section',
            text: `${paper} - ${secNode.section}`,
            targetPageInternal: pdfDoc.getPageCount()
        });

        // Add Section Divider Page
        const sPage = pdfDoc.addPage();
        sPage.drawRectangle({
            x: 0, y: 0, width: tw, height: th, color: rgb(0.12, 0.15, 0.28) // Very dark blue bg
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

        // Iterate over Topics under this Section
        for (const topNode of secNode.topics) {
            // Record Topic in Index
            indexData.push({
                type: 'topic',
                text: topNode.title,
                targetPageInternal: pdfDoc.getPageCount()
            });

            // Add Topic Divider Page
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

            // Iterate over questions
            for (let qIdx = 0; qIdx < topNode.questions.length; qIdx++) {
                const item = topNode.questions[qIdx];
                
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

                // Helper function to wrap text
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
                    for (const activeFileObj of activeFileObjects) {
                        const cloudUrl = activeFileObj.url.replace('https//', 'https://').replace('http//', 'http://');
                        try {
                            const arrayBuffer = fetchedBuffers[activeFileObj.url];
                            if (!arrayBuffer) throw new Error(`Failed to pre-fetch from ${cloudUrl}`);
                            const sourcePdfDoc = await PDFDocument.load(arrayBuffer);
                            const sourcePageIndices = sourcePdfDoc.getPageIndices();
                            
                            if (sourcePageIndices.length > 0) {
                                // 1. Embed the first page of the answer
                                const firstPage = sourcePdfDoc.getPage(0);
                                const { width: sw, height: sh } = firstPage.getSize();
                                
                                // Wrap question text to smaller size (9)
                                const maxQWidth = tw - 60;
                                const qLines = wrapText(cleanText, 9, maxQWidth, fontNormal);
                                const maxVisibleLines = Math.min(qLines.length, 5);
                                
                                const highlightHeight = 40 + maxVisibleLines * 12;
                                const headerHeight = 15 + highlightHeight + 10;
                                
                                // Create a new page in the compiled PDF for page 1 of the answer
                                const newPage = pdfDoc.addPage([tw, th]);
                                
                                // Draw header background card (light yellow, no border)
                                newPage.drawRectangle({
                                    x: 20,
                                    y: th - 15 - highlightHeight,
                                    width: tw - 40,
                                    height: highlightHeight,
                                    color: rgb(0.99, 0.96, 0.80)
                                });
                                
                                // Draw Topper Tag (center-aligned, bold, size 10)
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
                                
                                // Draw Question Text (center-aligned, normal, size 9)
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
                                
                                // Embed first page of source document
                                const embeddedPage = await pdfDoc.embedPage(firstPage);
                                
                                // Calculate scaling to fit remaining space
                                const remainingWidth = tw - 40;
                                const remainingHeight = th - headerHeight - 25; // 15 bottom margin, 10 gap
                                
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
                                
                                // Add subsequent pages of the answer as-is
                                const restPageIndices = sourcePageIndices.slice(1);
                                if (restPageIndices.length > 0) {
                                    const sourcePages = await pdfDoc.copyPages(sourcePdfDoc, restPageIndices);
                                    sourcePages.forEach(p => pdfDoc.addPage(p));
                                }
                            } else {
                                throw new Error("Answer PDF contains no pages.");
                            }
                        } catch (pdfErr) {
                            console.error(`Error appending PDF ${cloudUrl}:`, pdfErr);
                            // Fallback: draw a beautiful error page indicating this specific topper's answer could not be loaded
                            const errPage = pdfDoc.addPage([tw, th]);
                            
                            errPage.drawRectangle({
                                x: 0, y: 0, width: tw, height: th,
                                color: rgb(0.98, 0.95, 0.95) // soft red bg
                            });
                            
                            // Yellow highlight header
                            const maxQWidth = tw - 60;
                            const qLines = wrapText(cleanText, 9, maxQWidth, fontNormal);
                            const maxVisibleLines = Math.min(qLines.length, 5);
                            const highlightHeight = 40 + maxVisibleLines * 12;
                            
                            errPage.drawRectangle({
                                x: 20,
                                y: th - 15 - highlightHeight,
                                width: tw - 40,
                                height: highlightHeight,
                                color: rgb(0.99, 0.96, 0.80)
                            });
                            
                            const tName = activeFileObj.topper_name || 'Unknown Topper';
                            const topperTagStr = `Topper: ${tName} (ANSWER SHEET LOAD ERROR)`;
                            const tagWidth = fontBold.widthOfTextAtSize(topperTagStr, 10);
                            errPage.drawText(topperTagStr, {
                                x: (tw - tagWidth) / 2,
                                y: th - 30,
                                size: 10,
                                font: fontBold,
                                color: rgb(0.8, 0.2, 0.2)
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
                                    x: (tw - lineW) / 2,
                                    y: qTextY,
                                    size: 9,
                                    font: fontNormal,
                                    color: rgb(0, 0, 0)
                                });
                                qTextY -= qLineHeight;
                            }
                            
                            // Error description below header
                            const warnY = th - 15 - highlightHeight - 120;
                            errPage.drawRectangle({
                                x: 40, y: warnY, width: tw - 80, height: 95,
                                color: rgb(1, 1, 1),
                                borderColor: rgb(0.9, 0.7, 0.7),
                                borderWidth: 1
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
                    // Placeholder page for no selected toppers
                    const qPage = pdfDoc.addPage([tw, th]);
                    
                    qPage.drawRectangle({
                        x: 0, y: 0, width: tw, height: th,
                        color: rgb(0.97, 0.98, 0.99)
                    });
                    
                    const maxQWidth = tw - 60;
                    const qLines = wrapText(cleanText, 9, maxQWidth, fontNormal);
                    const maxVisibleLines = Math.min(qLines.length, 5);
                    const highlightHeight = 40 + maxVisibleLines * 12;
                    
                    // Yellow highlight card
                    qPage.drawRectangle({
                        x: 20,
                        y: th - 15 - highlightHeight,
                        width: tw - 40,
                        height: highlightHeight,
                        color: rgb(0.99, 0.96, 0.80)
                    });
                    
                    const headerLabel = "NO TOPPER RESPONSE SELECTED";
                    const labelW = fontBold.widthOfTextAtSize(headerLabel, 10);
                    qPage.drawText(headerLabel, {
                        x: (tw - labelW) / 2,
                        y: th - 30,
                        size: 10,
                        font: fontBold,
                        color: rgb(0.8, 0.2, 0.2)
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
                            x: (tw - lineW) / 2,
                            y: qTextY,
                            size: 9,
                            font: fontNormal,
                            color: rgb(0, 0, 0)
                        });
                        qTextY -= qLineHeight;
                    }
                    
                    const warnY = th - 15 - highlightHeight - 120;
                    qPage.drawRectangle({
                        x: 40, y: warnY, width: tw - 80, height: 95,
                        color: rgb(0.98, 0.94, 0.94),
                        borderColor: rgb(0.9, 0.8, 0.8),
                        borderWidth: 1
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

    const indexPages = await pdfDoc.copyPages(indexPdfDoc, indexPdfDoc.getPageIndices());
    const totalIndexPages = indexPages.length;
    
    for (let k = 0; k < totalIndexPages; k++) {
        pdfDoc.insertPage(1 + k, indexPages[k]);
    }

    // Numbering pass
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

    const pdfBytes = await pdfDoc.save();

    res.setHeader('Content-Disposition', `attachment; filename="Formal_PSIR_${paper.replace(/[^a-z0-9]/gi, '_')}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBytes));

  } catch (error) {
    console.error(`[PsirController] Error generating PDF:`, error);
    res.status(500).json({ error: 'Failed to generate PDF book.', details: error.message });
  }
};
