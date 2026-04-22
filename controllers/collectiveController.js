import { UPSCQA } from '../models/UPSCQA.js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export const previewSubjectData = async (req, res) => {
  try {
    const { tag, subject } = req.query;
    const filterTag = tag || subject;

    if (!filterTag) {
      return res.status(400).json({ error: 'Tag is required.' });
    }

    const questions = await UPSCQA.find({ 
       tags: filterTag 
    }).sort({ start_page: 1 });

    if (!questions || questions.length === 0) {
      return res.status(404).json({ error: 'No questions found.' });
    }

    res.json(questions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch preview data.' });
  }
}

export const generateCollectivePdf = async (req, res) => {
  try {
    const { tag, subject, selections, includedQuestionIds } = req.body;
    const filterTag = tag || subject;

    if (!filterTag) {
      return res.status(400).json({ error: 'Tag is required to generate collective PDF.' });
    }

    let query = { tags: filterTag };
    if (includedQuestionIds && Array.isArray(includedQuestionIds)) {
      query._id = { $in: includedQuestionIds };
    }

    let questionsResponse = await UPSCQA.find(query).sort({ start_page: 1 });

    if (!questionsResponse || questionsResponse.length === 0) {
      return res.status(404).json({ error: 'No matched/selected questions found.' });
    }

    // 1. Initialize Master PDF Document
    const pdfDoc = await PDFDocument.create();
    
    // Embed Standard Fonts
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // 2. Create Formal Cover Page
    const titlePage = pdfDoc.addPage();
    const { width: tw, height: th } = titlePage.getSize();
    
    // Draw thick colored header bar
    titlePage.drawRectangle({
        x: 0, y: th - 100, width: tw, height: 100, color: rgb(0.14, 0.16, 0.28)
    });
    
    titlePage.drawText(`UPSC DOCUMENT LIBRARY`, {
      x: 50, y: th - 60, size: 28, font: fontBold, color: rgb(1, 1, 1)
    });

    const subTextWidth = fontBold.widthOfTextAtSize(filterTag.toUpperCase(), 36);
    titlePage.drawText(filterTag.toUpperCase(), {
      x: (tw - subTextWidth)/2, y: th / 2, size: 36, font: fontBold, color: rgb(0.1, 0.1, 0.1)
    });

    titlePage.drawText(`Formal Extract Report`, {
      x: tw/2 - 70, y: th/2 - 40, size: 16, font: fontNormal, color: rgb(0.5, 0.5, 0.5)
    });

    // We will dynamically create the Index and prepend it. We must track page offsets.
    const indexData = []; // { topic: "...", startPage: X }
    
    // Group questions by the first matching inner Tag (to act like a Topic) or just a generic block
    const groupedByTopic = {};
    for (const q of questionsResponse) {
        // Find a tag that isn't the main filterTag to use as a section header
        const secTag = q.tags && q.tags.find(t => t !== filterTag) ? q.tags.find(t => t !== filterTag) : filterTag;
        if (!groupedByTopic[secTag]) groupedByTopic[secTag] = [];
        groupedByTopic[secTag].push(q);
    }

    // 3. Document Building
    for (const topic of Object.keys(groupedByTopic)) {
        const topicQuestions = groupedByTopic[topic];
        
        // Track for index
        indexData.push({
            topic: topic,
            targetPageInternal: pdfDoc.getPageCount()
        });

        // Insert Topic Divider Page
        const tPage = pdfDoc.addPage();
        tPage.drawRectangle({
            x: 0, y: 0, width: tw, height: th, color: rgb(0.16, 0.2, 0.3) // Dark blue background
        });

        const topicText1 = "TOPIC";
        const topicText2 = topic.toUpperCase();
        
        tPage.drawText(topicText1, {
            x: 50, y: th - 150, size: 24, font: fontNormal, color: rgb(0.6, 0.7, 0.9)
        });

        // Wrap Text for long topics
        let tY = th - 200;
        const words = topicText2.split(' ');
        let line = '';
        for (const word of words) {
            const testLine = line + word + ' ';
            if (fontBold.widthOfTextAtSize(testLine, 36) > tw - 100) {
                tPage.drawText(line, { x: 50, y: tY, size: 36, font: fontBold, color: rgb(1, 1, 1) });
                line = word + ' ';
                tY -= 45;
            } else {
                line = testLine;
            }
        }
        tPage.drawText(line, { x: 50, y: tY, size: 36, font: fontBold, color: rgb(1, 1, 1) });

        // Now append the questions for this Topic
        for (let qIdx = 0; qIdx < topicQuestions.length; qIdx++) {
            const item = topicQuestions[qIdx];
            
            // Determine which URL to use based on frontend selections
            let activeFileObj = null;
            if (item.file_urls && item.file_urls.length > 0) {
                 if (selections && selections[item._id]) {
                     activeFileObj = item.file_urls.find(f => f.url === selections[item._id]);
                 }
                 // Default to first if somehow no selection made
                 if (!activeFileObj && item.file_urls.length > 0) {
                     activeFileObj = item.file_urls[0];
                 }
            }

            // Append the actual physical PDF for the *selected* topper
            if (activeFileObj) {
                // Add a helper replacer incase of Malformed Database String
                const cloudUrl = activeFileObj.url.replace('https//', 'https://').replace('http//', 'http://');

                try {
                    // Fetch the file remotely from Cloudinary over the network
                    const response = await fetch(cloudUrl);
                    if (!response.ok) throw new Error(`Failed to fetch from ${cloudUrl}`);
                    
                    const arrayBuffer = await response.arrayBuffer();
                    const sourcePdfDoc = await PDFDocument.load(arrayBuffer);
                    const sourcePages = await pdfDoc.copyPages(sourcePdfDoc, sourcePdfDoc.getPageIndices());
                        
                        if (sourcePages.length > 0) {
                            const p0 = sourcePages[0];
                            const { width: p0w, height: p0h } = p0.getSize();

                            // The space to take is roughly 10% -> Using max available space tightly (~60-80 units)
                            const barHeight = 25;
                            const barY = p0h - barHeight;

                            // Draw full-width horizontal box covering original top pixels
                            p0.drawRectangle({
                                x: 0, y: barY, width: p0w, height: barHeight, color: rgb(0.92, 0.95, 0.98)
                            });

                            // Build Topper Detail String
                            const tName = activeFileObj.topper_name || 'Unknown Name';
                            const tYear = activeFileObj.topper_year ? ` | Year: ${activeFileObj.topper_year}` : '';
                            const tRank = activeFileObj.topper_rank ? ` | Rank: ${activeFileObj.topper_rank}` : '';
                            const tMarks = activeFileObj.topper_marks ? ` | Marks: ${activeFileObj.topper_marks}` : '';
                            
                            const dString = `[Q${qIdx + 1}] TOPPER: ${tName}${tYear}${tRank}${tMarks}`;

                            // Center align the text natively over the bar
                            const textWidth = fontBold.widthOfTextAtSize(dString.toUpperCase(), 9);
                            p0.drawText(dString.toUpperCase(), {
                                x: (p0w - textWidth) / 2, y: barY + 8, size: 9, font: fontBold, color: rgb(0.1, 0.2, 0.4)
                            });

                            // Draw Question Text below the bar natively over the writing space
                            let qY = barY - 14;
                            const qWords = item.question_text.split(' ');
                            let qLine = '';
                            
                            // Using smaller font-size 10 for Question to ensure it fits tightly
                            for (const word of qWords) {
                                const testLine = qLine + word + ' ';
                                if (fontBold.widthOfTextAtSize(testLine, 10) > p0w - 30) {
                                    // Use a subtle white backdrop to ensure question text is readable if there's overlap
                                    p0.drawRectangle({ x: 13, y: qY - 2, width: p0w - 26, height: 14, color: rgb(1,1,1), opacity: 0.85 });
                                    p0.drawText(qLine, { x: 15, y: qY, size: 10, font: fontBold, color: rgb(0.25, 0.1, 0.1) });
                                    qLine = word + ' ';
                                    qY -= 12;
                                } else {
                                    qLine = testLine;
                                }
                            }
                            p0.drawRectangle({ x: 13, y: qY - 2, width: p0w - 26, height: 14, color: rgb(1,1,1), opacity: 0.85 });
                            p0.drawText(qLine, { x: 15, y: qY, size: 10, font: fontBold, color: rgb(0.25, 0.1, 0.1) });
                        }

                        // Append all mapped pages directly
                        sourcePages.forEach(p => pdfDoc.addPage(p));
                } catch (pdfErr) {
                    // FIXED: Now properly logs the cloudUrl instead of crashing on the undefined localPdfPath
                    console.error(`Error appending PDF ${cloudUrl}:`, pdfErr);
                }
            }
        }
    }

    // 4. Generate Formal Index / Table of Contents
    const indexPdfDoc = await PDFDocument.create();
    let idxPage = indexPdfDoc.addPage();
    let idxY = idxPage.getSize().height - 80;

    idxPage.drawText(`TABLE OF CONTENTS`, { x: 50, y: idxY, size: 28, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
    idxY -= 50;

    // Table settings
    const tableX = 50;
    const tableW = idxPage.getSize().width - 100;
    const rowH = 35;
    
    // Draw Header Row
    idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.9, 0.9, 0.95) });
    idxPage.drawText(`Topic Layout Segment`, { x: tableX + 15, y: idxY + 12, size: 12, font: fontBold });
    idxPage.drawText(`PG`, { x: tableX + tableW - 40, y: idxY + 12, size: 12, font: fontBold });
    idxY -= rowH;

    for (let j = 0; j < indexData.length; j++) {
        const row = indexData[j];
        
        if (idxY < 50) {
             idxPage = indexPdfDoc.addPage();
             idxY = idxPage.getSize().height - 80;
             // Recreate Header
             idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.9, 0.9, 0.95) });
             idxPage.drawText(`Topic Layout Segment`, { x: tableX + 15, y: idxY + 12, size: 12, font: fontBold });
             idxY -= rowH;
        }

        // Draw Row borders
        idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 });
        
        // Truncate logic
        let dText = row.topic;
        if (dText.length > 70) dText = dText.substring(0, 67) + '...';
        
        idxPage.drawText(dText, { x: tableX + 15, y: idxY + 12, size: 11, font: fontNormal, color: rgb(0.2, 0.2, 0.2) });
        // The Page string placeholder! We will write the page number physically. We know indexData holds the theoretical offset.
        
        idxY -= rowH;
    }

    // Now copy index pages into the master layout at position 1
    const indexPages = await pdfDoc.copyPages(indexPdfDoc, indexPdfDoc.getPageIndices());
    const totalIndexPages = indexPages.length;
    
    for (let k = 0; k < totalIndexPages; k++) {
        pdfDoc.insertPage(1 + k, indexPages[k]);
    }

    // Perform second pass on the embedded Index Pages to stamp the EXACT dynamic numbers
    let currentDataRow = 0;
    
    for (let k = 0; k < totalIndexPages; k++) {
        const injectedIdxPage = pdfDoc.getPage(1 + k);
        // Recalculate Y alignment bounds precisely matching pass 1
        let drawY = k === 0 
           ? (injectedIdxPage.getSize().height - 130 - rowH) 
           : (injectedIdxPage.getSize().height - 80 - rowH);
        
        while (currentDataRow < indexData.length && drawY >= 50) {
             const truePageNum = 1 + totalIndexPages + indexData[currentDataRow].targetPageInternal;
             injectedIdxPage.drawText(`${truePageNum}`, { 
                 x: tableX + tableW - 40, 
                 y: drawY + 12, 
                 size: 11, font: fontBold, color: rgb(0.1, 0.1, 0.1) 
             });
             drawY -= rowH;
             currentDataRow++;
        }
    }

    // 5. Finalize and Send
    const pdfBytes = await pdfDoc.save();

    res.setHeader('Content-Disposition', `attachment; filename="Formal_UPSC_Book_${filterTag.replace(/[^a-z0-9]/gi, '_')}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBytes));

  } catch (error) {
    console.error(`[CollectiveController] Error generating collective PDF:`, error);
    res.status(500).json({ error: 'Failed to generate collective PDF book.' });
  }
};