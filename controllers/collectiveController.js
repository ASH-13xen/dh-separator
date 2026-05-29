import { UPSCQA } from '../models/UPSCQA.js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadModuleHierarchy(moduleName) {
    const constantsDir = path.join(__dirname, '../constants');
    let finalModuleName = moduleName;
    
    // Normalize Optional Subject if needed
    if (!finalModuleName.startsWith('GS-') && !finalModuleName.startsWith('OptionalSubject')) {
       const cleanName = finalModuleName.replace(/\s+/g, '');
       finalModuleName = `OptionalSubject${cleanName.charAt(0).toUpperCase()}${cleanName.slice(1)}`;
    }
    
    const filePath = path.join(constantsDir, `${finalModuleName}.json`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Module ${finalModuleName} not found.`);
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
}

export const previewSubjectData = async (req, res) => {
  try {
    const { moduleName } = req.query; // e.g., 'GS-1'

    if (!moduleName) {
      return res.status(400).json({ error: 'Module name is required.' });
    }

    const hierarchy = await loadModuleHierarchy(moduleName);
    const questions = await UPSCQA.find({ tags: moduleName }).sort({ start_page: 1 });

    if (!questions || questions.length === 0) {
      return res.status(404).json({ error: 'No questions found for this module.' });
    }

    const matchedQuestionIds = new Set();

    const isOptional = moduleName.startsWith('OptionalSubject');
    
    // Process hierarchy
    const resultData = [];
    const processHierarchy = (paperFilter) => {
        for (const sec of hierarchy) {
            if (!sec.section) continue;
            
            const secObj = {
                section: paperFilter ? `${paperFilter}: ${sec.section}` : sec.section,
                topics: []
            };
            
            if (sec.topics && Array.isArray(sec.topics)) {
                for (const top of sec.topics) {
                    if (!top.title) continue;
                    
                    let matchedQ = questions.filter(q => q.tags && q.tags.includes(top.title));
                    if (paperFilter) {
                        matchedQ = matchedQ.filter(q => q.tags.includes(paperFilter));
                    }
                    
                    if (matchedQ.length > 0) {
                        matchedQ.forEach(q => matchedQuestionIds.add(q._id.toString()));
                        secObj.topics.push({ title: top.title, questions: matchedQ });
                    }
                }
            }
            if (secObj.topics.length > 0) resultData.push(secObj);
        }
    };

    if (isOptional) {
        processHierarchy("Paper 1");
        processHierarchy("Paper 2");
    } else {
        processHierarchy(null);
    }

    // Collect questions that are mapped to the module but lack specific inner topic tags
    const unmatchedQuestions = questions.filter(q => !matchedQuestionIds.has(q._id.toString()));
    if (unmatchedQuestions.length > 0) {
        resultData.push({
            section: "Uncategorized Topics",
            topics: [{
                title: "General Questions",
                questions: unmatchedQuestions
            }]
        });
    }

    res.json(resultData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch hierarchical preview data.' });
  }
}

export const generateCollectivePdf = async (req, res) => {
  try {
    const { moduleName, selections, includedQuestionIds } = req.body;

    if (!moduleName) {
      return res.status(400).json({ error: 'Module name is required to generate collective PDF.' });
    }

    const hierarchy = await loadModuleHierarchy(moduleName);

    let query = { tags: moduleName };
    if (includedQuestionIds && Array.isArray(includedQuestionIds)) {
      query._id = { $in: includedQuestionIds };
    }

    const questionsResponse = await UPSCQA.find(query).sort({ start_page: 1 });

    if (!questionsResponse || questionsResponse.length === 0) {
      return res.status(404).json({ error: 'No matched/selected questions found.' });
    }

    const isOptional = moduleName.startsWith('OptionalSubject');
    const matchedQuestionIds = new Set();
    const docData = [];

    const processHierarchy = (paperFilter) => {
        for (const sec of hierarchy) {
            if (!sec.section) continue;
            const mappedTopics = [];
            if (sec.topics && Array.isArray(sec.topics)) {
                for (const top of sec.topics) {
                    if (!top.title) continue;
                    let matchedQ = questionsResponse.filter(q => q.tags && q.tags.includes(top.title));
                    if (paperFilter) {
                        matchedQ = matchedQ.filter(q => q.tags.includes(paperFilter));
                    }
                    if (matchedQ.length > 0) {
                        if (includedQuestionIds && Array.isArray(includedQuestionIds)) {
                            // Sort by the exact order provided in includedQuestionIds
                            matchedQ.sort((a, b) => {
                                const idxA = includedQuestionIds.indexOf(a._id.toString());
                                const idxB = includedQuestionIds.indexOf(b._id.toString());
                                return idxA - idxB;
                            });
                        }
                        matchedQ.forEach(q => matchedQuestionIds.add(q._id.toString()));
                        mappedTopics.push({ title: top.title, questions: matchedQ });
                    }
                }
            }
            if (mappedTopics.length > 0) {
                docData.push({ 
                    section: paperFilter ? `${paperFilter}: ${sec.section}` : sec.section, 
                    topics: mappedTopics 
                });
            }
        }
    };

    if (isOptional) {
        processHierarchy("Paper 1");
        processHierarchy("Paper 2");
    } else {
        processHierarchy(null);
    }

    const unmatchedQuestions = questionsResponse.filter(q => !matchedQuestionIds.has(q._id.toString()));
    if (unmatchedQuestions.length > 0) {
        docData.push({
            section: "Uncategorized Topics",
            topics: [{ title: "General Questions", questions: unmatchedQuestions }]
        });
    }

    // 1. Initialize Master PDF Document
    const pdfDoc = await PDFDocument.create();
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // 2. Create Premium & Energetic Cover Page
    const titlePage = pdfDoc.addPage();
    const { width: tw, height: th } = titlePage.getSize();
    
    // Background
    titlePage.drawRectangle({
        x: 0, y: 0, width: tw, height: th, color: rgb(0.98, 0.98, 0.99)
    });

    // Energetic Top Accent blocks
    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw, height: 180, color: rgb(0.14, 0.16, 0.28) // Deep Blue
    });
    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw * 0.6, height: 10, color: rgb(0.96, 0.35, 0.14) // Vibrant Orange
    });
    titlePage.drawRectangle({
        x: tw * 0.6, y: th - 180, width: tw * 0.4, height: 10, color: rgb(0.25, 0.51, 0.96) // Vibrant Blue
    });
    
    titlePage.drawText(`UPSC DOCUMENT LIBRARY`, {
      x: 50, y: th - 80, size: 36, font: fontBold, color: rgb(1, 1, 1)
    });
    
    titlePage.drawText(`Comprehensive Question Bank & Extracted Answers`, {
      x: 50, y: th - 120, size: 16, font: fontNormal, color: rgb(0.7, 0.7, 0.8)
    });

    // Module Name Processing (with dynamic sizing / word wrap)
    const moduleText = `${moduleName.replace(/([a-z])([A-Z])/g, '$1 $2').replace('OptionalSubject', 'Optional Subject: ').toUpperCase()} MODULE`;
    
    let fontSize = 48;
    let textWidth = fontBold.widthOfTextAtSize(moduleText, fontSize);
    
    // Auto-scale down if it's too wide
    while (textWidth > tw - 100 && fontSize > 24) {
        fontSize -= 2;
        textWidth = fontBold.widthOfTextAtSize(moduleText, fontSize);
    }
    
    // If still too wide, we split it into two lines
    if (textWidth > tw - 100) {
        const words = moduleText.split(' ');
        let line1 = '';
        let line2 = '';
        for (let i = 0; i < words.length; i++) {
            if (i < words.length / 2) line1 += words[i] + ' ';
            else line2 += words[i] + ' ';
        }
        const lw1 = fontBold.widthOfTextAtSize(line1.trim(), 28);
        const lw2 = fontBold.widthOfTextAtSize(line2.trim(), 28);
        
        titlePage.drawText(line1.trim(), {
          x: (tw - lw1)/2, y: th / 2 + 20, size: 28, font: fontBold, color: rgb(0.1, 0.1, 0.1)
        });
        titlePage.drawText(line2.trim(), {
          x: (tw - lw2)/2, y: th / 2 - 20, size: 28, font: fontBold, color: rgb(0.1, 0.1, 0.1)
        });
    } else {
        titlePage.drawText(moduleText, {
          x: (tw - textWidth)/2, y: th / 2, size: fontSize, font: fontBold, color: rgb(0.1, 0.1, 0.1)
        });
    }

    // Energetic Bottom Accent
    titlePage.drawRectangle({
        x: 50, y: 150, width: tw - 100, height: 2, color: rgb(0.8, 0.8, 0.8)
    });
    titlePage.drawText(`AI-Generated Knowledge Repository`, {
      x: tw/2 - 130, y: 110, size: 16, font: fontNormal, color: rgb(0.4, 0.4, 0.4)
    });
    titlePage.drawText(`${new Date().getFullYear()} Edition`, {
      x: tw/2 - 35, y: 80, size: 14, font: fontBold, color: rgb(0.14, 0.16, 0.28)
    });

    const indexData = []; // { type: 'section'|'topic', text: "...", targetPageInternal: X }

    // 3. Document Building
    for (const secNode of docData) {
        // Record Section in Index
        indexData.push({
            type: 'section',
            text: secNode.section,
            targetPageInternal: pdfDoc.getPageCount()
        });

        // Add Section Divider Page
        const sPage = pdfDoc.addPage();
        sPage.drawRectangle({
            x: 0, y: 0, width: tw, height: th, color: rgb(0.12, 0.14, 0.22) // Very dark blue bg
        });

        sPage.drawText("SECTION", {
            x: 50, y: th - 150, size: 24, font: fontNormal, color: rgb(0.6, 0.7, 0.9)
        });

        let sY = th - 200;
        const sWords = secNode.section.toUpperCase().split(' ');
        let sLine = '';
        for (const word of sWords) {
            const testLine = sLine + word + ' ';
            if (fontBold.widthOfTextAtSize(testLine, 18) > tw - 100) {
                sPage.drawText(sLine, { x: 50, y: sY, size: 18, font: fontBold, color: rgb(1, 1, 1) });
                sLine = word + ' ';
                sY -= 25;
            } else {
                sLine = testLine;
            }
        }
        sPage.drawText(sLine, { x: 50, y: sY, size: 18, font: fontBold, color: rgb(1, 1, 1) });

        // Iterate over Topics under this Section
        for (const topNode of secNode.topics) {
            // Record Topic in Index
            indexData.push({
                type: 'topic',
                text: topNode.title,
                targetPageInternal: pdfDoc.getPageCount()
            });

            // Iterate over questions
            for (let qIdx = 0; qIdx < topNode.questions.length; qIdx++) {
                const item = topNode.questions[qIdx];
                
                let activeFileObj = null;
                if (item.file_urls && item.file_urls.length > 0) {
                     if (selections && selections[item._id]) {
                         activeFileObj = item.file_urls.find(f => f.url === selections[item._id]);
                     }
                     if (!activeFileObj && item.file_urls.length > 0) {
                         activeFileObj = item.file_urls[0];
                     }
                }

                if (activeFileObj) {
                    const cloudUrl = activeFileObj.url.replace('https//', 'https://').replace('http//', 'http://');

                    try {
                        const response = await fetch(cloudUrl);
                        if (!response.ok) throw new Error(`Failed to fetch from ${cloudUrl}`);
                        
                        const arrayBuffer = await response.arrayBuffer();
                        const sourcePdfDoc = await PDFDocument.load(arrayBuffer);
                        const sourcePages = await pdfDoc.copyPages(sourcePdfDoc, sourcePdfDoc.getPageIndices());
                            
                        if (sourcePages.length > 0) {
                            const p0 = sourcePages[0];
                            const { width: p0w, height: p0h } = p0.getSize();

                            // Professional Full-Width Header
                            const barHeight = 110;
                            const barY = p0h - barHeight;

                            // Draw a clean background to cover existing top content and act as header background
                            p0.drawRectangle({
                                x: 0, y: barY, width: p0w, height: barHeight, 
                                color: rgb(0.97, 0.98, 0.99)
                            });

                            // Bottom border for the header
                            p0.drawLine({
                                start: { x: 0, y: barY },
                                end: { x: p0w, y: barY },
                                thickness: 2,
                                color: rgb(0.2, 0.4, 0.6)
                            });

                            const tName = activeFileObj.topper_name || 'Unknown Name';
                            let details = [tName.toUpperCase()];
                            if (activeFileObj.topper_year) details.push(`YEAR: ${activeFileObj.topper_year}`);
                            if (activeFileObj.topper_rank) details.push(`RANK: ${activeFileObj.topper_rank}`);
                            if (activeFileObj.topper_marks) details.push(`MARKS: ${activeFileObj.topper_marks}`);
                            const docHeader = `[TOPIC: ${topNode.title}]  |  TOPPER: ${details.join(' | ')}`;

                            // Center alignment for topper details
                            const docHeaderWidth = fontNormal.widthOfTextAtSize(docHeader, 9);
                            p0.drawText(docHeader, {
                                x: (p0w - docHeaderWidth) / 2, // Center aligned
                                y: p0h - 20, 
                                size: 9, 
                                font: fontNormal, 
                                color: rgb(0.4, 0.4, 0.4)
                            });

                            let qY = p0h - 45;
                            const rawText = item.question_text || "Question text unavailable.";
                            // Match Q1, Q.1, Question 1, etc., including optional punctuation and spaces
                            const prefixMatch = rawText.match(/^(?:Q\s*\d+|Q\.\s*\d+|Question\s*\d+)[.)\s:-]*/i);
                            let cleanText = rawText;
                            
                            if (prefixMatch) {
                                cleanText = rawText.substring(prefixMatch[0].length).trim();
                            }

                            // Wrap and draw the question text with full breadth
                            const textMargin = 20; // Modest padding
                            const maxTextWidth = p0w - (textMargin * 2);
                            
                            const qWords = cleanText.replace(/\n/g, ' ').split(' ');
                            let qLine = '';
                            
                            for (const word of qWords) {
                                const testLine = qLine + word + ' ';
                                if (fontBold.widthOfTextAtSize(testLine, 12) > maxTextWidth) {
                                    p0.drawText(qLine, { x: textMargin, y: qY, size: 12, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
                                    qLine = word + ' ';
                                    qY -= 18; // slightly more line height for readability
                                } else {
                                    qLine = testLine;
                                }
                            }
                            p0.drawText(qLine, { x: textMargin, y: qY, size: 12, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
                        }

                        sourcePages.forEach(p => pdfDoc.addPage(p));
                    } catch (pdfErr) {
                        console.error(`Error appending PDF ${cloudUrl}:`, pdfErr);
                    }
                }
            }
        }
    }

    // 4. Generate Formal Hierarchical Index
    const indexPdfDoc = await PDFDocument.create();
    let idxPage = indexPdfDoc.addPage();
    let idxY = idxPage.getSize().height - 80;

    idxPage.drawText(`TABLE OF CONTENTS`, { x: 50, y: idxY, size: 28, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
    idxY -= 50;

    const tableX = 50;
    const tableW = idxPage.getSize().width - 100;
    const rowH = 30;
    
    idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.9, 0.9, 0.95) });
    idxPage.drawText(`Module Layout`, { x: tableX + 15, y: idxY + 10, size: 12, font: fontBold });
    idxPage.drawText(`PG`, { x: tableX + tableW - 40, y: idxY + 10, size: 12, font: fontBold });
    idxY -= rowH;

    for (let j = 0; j < indexData.length; j++) {
        const row = indexData[j];
        
        if (idxY < 50) {
             idxPage = indexPdfDoc.addPage();
             idxY = idxPage.getSize().height - 80;
             idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.9, 0.9, 0.95) });
             idxPage.drawText(`Module Layout (Cont.)`, { x: tableX + 15, y: idxY + 10, size: 12, font: fontBold });
             idxPage.drawText(`PG`, { x: tableX + tableW - 40, y: idxY + 10, size: 12, font: fontBold });
             idxY -= rowH;
        }

        const isSection = row.type === 'section';
        const indentX = isSection ? 10 : 30;
        const fontSize = isSection ? 12 : 10;
        const curFont = isSection ? fontBold : fontNormal;
        
        if (!isSection) {
            // Draw lighter row border for topics
            idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 1 });
        } else {
            // Darker border and bg for Sections
            idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.95, 0.97, 1.0), borderColor: rgb(0.7, 0.7, 0.8), borderWidth: 1 });
        }

        // Truncate logic
        let dText = row.text;
        const maxLen = isSection ? 60 : 65;
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
                 size: isSec ? 12 : 10, 
                 font: isSec ? fontBold : fontNormal, 
                 color: rgb(0.1, 0.1, 0.1) 
             });
             drawY -= rowH;
             currentDataRow++;
        }
    }

    const pdfBytes = await pdfDoc.save();

    res.setHeader('Content-Disposition', `attachment; filename="Formal_UPSC_Book_${moduleName.replace(/[^a-z0-9]/gi, '_')}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBytes));

  } catch (error) {
    console.error(`[CollectiveController] Error generating collective PDF:`, error);
    res.status(500).json({ error: 'Failed to generate collective PDF book.', details: error.message });
  }
};