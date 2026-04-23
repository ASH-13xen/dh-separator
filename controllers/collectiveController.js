import { UPSCQA } from '../models/UPSCQA.js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadModuleHierarchy(moduleName) {
    const constantsDir = path.join(__dirname, '../constants');
    const filePath = path.join(constantsDir, `${moduleName}.js`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Module ${moduleName} not found.`);
    }
    const modulePath = 'file:///' + filePath.replace(/\\/g, '/');
    const imported = await import(modulePath);
    
    const keys = Object.keys(imported);
    for (const k of keys) {
        if (Array.isArray(imported[k])) {
            return imported[k];
        }
    }
    return [];
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

    // Process hierarchy
    const resultData = [];
    for (const sec of hierarchy) {
        if (!sec.section) continue;
        
        const secObj = {
            section: sec.section,
            topics: []
        };
        
        if (sec.topics && Array.isArray(sec.topics)) {
            for (const top of sec.topics) {
                if (!top.title) continue;
                
                const topObj = {
                    title: top.title,
                    questions: []
                };
                
                // Find matching questions. 
                // We enforce that the question has exactly this topic tag.
                const matchedQ = questions.filter(q => q.tags && q.tags.includes(top.title));
                topObj.questions = matchedQ;
                
                if (matchedQ.length > 0) secObj.topics.push(topObj);
            }
        }
        
        if (secObj.topics.length > 0) resultData.push(secObj);
    }

    // In case there are questions strictly mapped to the module but not matching any specific inner topic
    // we could collect them into 'Uncategorized'. But per prompt, "everything should be section and then topic wise done sequentially".
    // Missing topic mappings are dropped to enforce strict hierarchy.

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

    // Group into hierarchy
    const docData = [];
    for (const sec of hierarchy) {
        if (!sec.section) continue;
        const mappedTopics = [];
        if (sec.topics && Array.isArray(sec.topics)) {
            for (const top of sec.topics) {
                if (!top.title) continue;
                const matchedQ = questionsResponse.filter(q => q.tags && q.tags.includes(top.title));
                if (matchedQ.length > 0) {
                    mappedTopics.push({ title: top.title, questions: matchedQ });
                }
            }
        }
        if (mappedTopics.length > 0) {
            docData.push({ section: sec.section, topics: mappedTopics });
        }
    }

    // 1. Initialize Master PDF Document
    const pdfDoc = await PDFDocument.create();
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // 2. Create Formal Cover Page
    const titlePage = pdfDoc.addPage();
    const { width: tw, height: th } = titlePage.getSize();
    
    titlePage.drawRectangle({
        x: 0, y: th - 100, width: tw, height: 100, color: rgb(0.14, 0.16, 0.28)
    });
    
    titlePage.drawText(`UPSC DOCUMENT LIBRARY`, {
      x: 50, y: th - 60, size: 28, font: fontBold, color: rgb(1, 1, 1)
    });

    const moduleText = `${moduleName.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()} MODULE`;
    const subTextWidth = fontBold.widthOfTextAtSize(moduleText, 36);
    titlePage.drawText(moduleText, {
      x: (tw - subTextWidth)/2, y: th / 2, size: 36, font: fontBold, color: rgb(0.1, 0.1, 0.1)
    });

    titlePage.drawText(`Formal Sequence Extract`, {
      x: tw/2 - 90, y: th/2 - 40, size: 16, font: fontNormal, color: rgb(0.5, 0.5, 0.5)
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
            if (fontBold.widthOfTextAtSize(testLine, 42) > tw - 100) {
                sPage.drawText(sLine, { x: 50, y: sY, size: 42, font: fontBold, color: rgb(1, 1, 1) });
                sLine = word + ' ';
                sY -= 55;
            } else {
                sLine = testLine;
            }
        }
        sPage.drawText(sLine, { x: 50, y: sY, size: 42, font: fontBold, color: rgb(1, 1, 1) });

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

                            // Use a solid top header bar to occlude the original page details
                            const barHeight = 40;
                            const barY = p0h - barHeight;

                            p0.drawRectangle({
                                x: 0, y: barY, width: p0w, height: barHeight, color: rgb(0.92, 0.95, 0.98)
                            });

                            // Subheader bar for context
                            p0.drawRectangle({
                                x: 0, y: barY - 14, width: p0w, height: 14, color: rgb(0.2, 0.25, 0.4)
                            });

                            const tName = activeFileObj.topper_name || 'Unknown Name';
                            let details = [tName.toUpperCase()];
                            if (activeFileObj.topper_year) details.push(`YEAR: ${activeFileObj.topper_year}`);
                            if (activeFileObj.topper_rank) details.push(`RANK: ${activeFileObj.topper_rank}`);
                            if (activeFileObj.topper_marks) details.push(`MARKS: ${activeFileObj.topper_marks}`);
                            const docHeader = `[TOPIC: ${topNode.title}] | TOPPER: ${details.join(' | ')}`;

                            const textWidth = fontBold.widthOfTextAtSize(docHeader, 9);
                            p0.drawText(docHeader, {
                                x: (p0w - textWidth) / 2, y: barY - 10, size: 9, font: fontBold, color: rgb(1, 1, 1)
                            });

                            let qY = barY + 20;
                            const qWords = item.question_text.split(' ');
                            let qLine = '';
                            
                            for (const word of qWords) {
                                const testLine = qLine + word + ' ';
                                if (fontBold.widthOfTextAtSize(testLine, 10) > p0w - 30) {
                                    p0.drawText(qLine, { x: 15, y: qY, size: 10, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
                                    qLine = word + ' ';
                                    qY -= 12;
                                } else {
                                    qLine = testLine;
                                }
                            }
                            p0.drawText(qLine, { x: 15, y: qY, size: 10, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
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