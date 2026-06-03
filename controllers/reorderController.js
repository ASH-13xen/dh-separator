import { processLargePdfInChunks, tagQuestionWithGemini } from '../services/geminiService.js';
import { ReorderPDF } from '../models/ReorderPDF.js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

// Local storage directory helper
const saveLocally = (buffer, fileName) => {
  const pdfDir = path.join(process.cwd(), 'public', 'extracted_pdfs');
  if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
  }
  const filePath = path.join(pdfDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return `/public/extracted_pdfs/${fileName}`;
};

const saveCompiledLocally = (buffer, fileName) => {
  const pdfDir = path.join(process.cwd(), 'public', 'reorder_books');
  if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
  }
  const filePath = path.join(pdfDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return `/public/reorder_books/${fileName}`;
};

// Local path resolver from URL
const getLocalPath = (fileUrl) => {
  try {
    const parsed = new URL(fileUrl, 'http://localhost');
    const decodedPathname = decodeURIComponent(parsed.pathname);
    // Remove leading slash if path.join expects relative components, 
    // but on Windows path.join with absolute-looking path handles it safely.
    return path.join(process.cwd(), decodedPathname);
  } catch (err) {
    return path.join(process.cwd(), fileUrl);
  }
};

export const processReorderPdf = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Please upload a valid PDF file.' });
    }

    console.log(`[ReorderController] Processing PDF for split & reorder (Local Only): ${req.file.originalname}`);
    const fileBuffer = req.file.buffer;

    // 1. Get question indexing from Gemini (with batch chunked service, forceContinuity = false)
    const indexArray = await processLargePdfInChunks(fileBuffer, 50, false);
    if (!indexArray || indexArray.length === 0) {
      return res.status(400).json({ error: 'No questions detected in this document.' });
    }

    // 2. Load PDF with pdf-lib to get total pages and split
    const mainPdfDoc = await PDFDocument.load(fileBuffer);
    const totalPages = mainPdfDoc.getPageCount();

    // 3. Build raw chunks list, keeping unmapped page gaps marked as separate chunks
    const rawChunks = [];
    let currentStart = 1;

    // Sort questions by start_page
    const sortedQuestions = [...indexArray].sort((a, b) => a.start_page - b.start_page);

    for (const q of sortedQuestions) {
      // If there is an unmapped gap before this question, keep it marked and separate
      if (q.start_page > currentStart) {
        rawChunks.push({
          question_text: `[Unmapped Pages ${currentStart} - ${q.start_page - 1}]`,
          start_page: currentStart,
          end_page: q.start_page - 1
        });
      }

      rawChunks.push({
        question_text: q.question_text,
        start_page: q.start_page,
        end_page: q.end_page
      });

      currentStart = q.end_page + 1;
    }

    // If there are leftover pages at the end
    if (currentStart <= totalPages) {
      rawChunks.push({
        question_text: `[Unmapped Pages ${currentStart} - ${totalPages}]`,
        start_page: currentStart,
        end_page: totalPages
      });
    }

    // 4. Split PDF into chunks and save them locally
    console.log(`[ReorderController] Splitting into ${rawChunks.length} local chunks...`);
    const finalChunks = [];

    for (let i = 0; i < rawChunks.length; i++) {
      const chunk = rawChunks[i];
      const startIdx = Math.max(0, chunk.start_page - 1);
      const endIdx = Math.min(totalPages - 1, chunk.end_page - 1);

      if (startIdx > endIdx) continue;

      const subPdf = await PDFDocument.create();
      const pagesToCopy = Array.from({ length: endIdx - startIdx + 1 }, (_, index) => startIdx + index);
      const copiedPages = await subPdf.copyPages(mainPdfDoc, pagesToCopy);
      copiedPages.forEach((page) => subPdf.addPage(page));

      const subPdfBytes = await subPdf.save();
      const fileName = `Reorder_${Date.now()}_chunk_${i + 1}.pdf`;

      // Save locally to the server public static directory
      const relativePath = saveLocally(Buffer.from(subPdfBytes), fileName);
      const fileUrl = `${req.protocol}://${req.get('host')}${relativePath}`;

      finalChunks.push({
        question_text: chunk.question_text,
        start_page: chunk.start_page,
        end_page: chunk.end_page,
        file_url: fileUrl
      });
    }

    // 5. Save record in database
    const record = await ReorderPDF.create({
      originalName: req.file.originalname,
      chunks: finalChunks
    });

    console.log(`[ReorderController] PDF processed locally. Created record: ${record._id}`);
    res.status(200).json({
      message: 'PDF successfully split, stored locally, and indexed.',
      data: record
    });

  } catch (error) {
    console.error("[ReorderController] Error in processReorderPdf:", error);
    if (error.message === 'LOCATION_NOT_SUPPORTED' || (error.message && error.message.includes('User location is not supported'))) {
      return res.status(403).json({ 
        error: 'Google Gemini API is restricted in the server\'s current location.' 
      });
    }
    res.status(500).json({ error: 'Failed to process PDF.', details: error.message });
  }
};

const loadModuleHierarchy = async (moduleName) => {
  const hierarchyPath = path.join(process.cwd(), 'backend', 'syllabus_hierarchy.json');
  if (!fs.existsSync(hierarchyPath)) {
      throw new Error("Syllabus hierarchy file not found.");
  }
  
  let finalModuleName = moduleName;
  if (!finalModuleName.startsWith('GS-') && !finalModuleName.startsWith('OptionalSubject')) {
     const cleanName = finalModuleName.replace(/\s+/g, '');
     finalModuleName = `OptionalSubject${cleanName.charAt(0).toUpperCase()}${cleanName.slice(1)}`;
  }
  
  const customData = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
  if (finalModuleName.startsWith('GS-')) {
     return customData.gsModules?.[finalModuleName] || [];
  } else {
     return customData.optionalSubjects?.[finalModuleName] || [];
  }
};

export const compileReorderPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const { subject } = req.body;
    const record = await ReorderPDF.findById(id);

    if (!record) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    const chunks = record.chunks;
    if (!chunks || chunks.length === 0) {
      return res.status(400).json({ error: 'No chunks available in sequence to compile.' });
    }

    // Fallback to old behavior if no subject is provided
    if (!subject) {
      console.log(`[ReorderController] Compiling ${chunks.length} chunks locally (Classic Merge) for record: ${id}`);
      
      const pdfBuffers = [];
      for (const chunk of chunks) {
        try {
          const localPath = getLocalPath(chunk.file_url);
          if (!fs.existsSync(localPath)) {
            throw new Error(`File not found: ${localPath}`);
          }
          const buffer = fs.readFileSync(localPath);
          pdfBuffers.push(buffer);
        } catch (readError) {
          console.error(`[ReorderController] Failed to read chunk from URL: ${chunk.file_url}`, readError);
          return res.status(500).json({ error: `Failed to read segment file from local storage: ${chunk.question_text.substring(0, 30)}...` });
        }
      }

      const mergedPdf = await PDFDocument.create();
      for (let i = 0; i < pdfBuffers.length; i++) {
        const buffer = pdfBuffers[i];
        const srcDoc = await PDFDocument.load(buffer);
        const copiedPages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      }

      const mergedPdfBytes = await mergedPdf.save();
      const fileName = `Compiled_Reorder_${id}_${Date.now()}.pdf`;

      const relativeCompiledPath = saveCompiledLocally(Buffer.from(mergedPdfBytes), fileName);
      const compiledUrl = `${req.protocol}://${req.get('host')}${relativeCompiledPath}`;

      record.pdfUrl = compiledUrl;
      await record.save();

      console.log(`[ReorderController] Successfully compiled PDF locally: ${record.pdfUrl}`);
      return res.status(200).json({
        message: 'PDF compiled and merged successfully.',
        data: record
      });
    }

    // Custom Book Creation with Cover page, Table of contents, Section Dividers, and Prefix Cleaning
    console.log(`[ReorderController] Initiating Custom Book Compilation for subject: ${subject}`);

    // 1. Skip unmapped pages
    const validChunks = chunks.filter(c => !c.question_text.startsWith('[Unmapped Pages'));
    if (validChunks.length === 0) {
      return res.status(400).json({ error: 'No valid mapped question chunks available to compile.' });
    }

    // 2. Classify each chunk strictly based on the subject via Gemini
    console.log(`[ReorderController] Tagging ${validChunks.length} questions strictly matching subject: ${subject}`);
    const taggedChunks = [];
    for (const chunk of validChunks) {
      const tags = await tagQuestionWithGemini(chunk.question_text, subject);
      taggedChunks.push({
        ...chunk.toObject(),
        tags: tags
      });
    }

    // 3. Group tagged chunks by syllabus hierarchy
    const hierarchy = await loadModuleHierarchy(subject);
    const isOptional = subject.startsWith('OptionalSubject');
    const matchedChunkIds = new Set();
    const docData = [];

    const processHierarchy = (paperFilter) => {
        for (const sec of hierarchy) {
            if (!sec.section) continue;
            const mappedTopics = [];
            if (sec.topics && Array.isArray(sec.topics)) {
                for (const top of sec.topics) {
                    if (!top.title) continue;
                    let matchedQ = taggedChunks.filter(q => q.tags && q.tags.includes(top.title));
                    if (paperFilter) {
                        matchedQ = matchedQ.filter(q => q.tags.includes(paperFilter));
                    }
                    if (matchedQ.length > 0) {
                        // Preserve original order from user sequence
                        matchedQ.sort((a, b) => {
                            const idxA = validChunks.findIndex(c => c._id.toString() === a._id.toString());
                            const idxB = validChunks.findIndex(c => c._id.toString() === b._id.toString());
                            return idxA - idxB;
                        });
                        matchedQ.forEach(q => matchedChunkIds.add(q._id.toString()));
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
        const paperTags = ["Paper 1", "Paper 2"];
        for (const paper of paperTags) {
            processHierarchy(paper);
        }
    } else {
        processHierarchy(null);
    }

    // Include Uncategorized
    const unmatchedChunks = taggedChunks.filter(q => !matchedChunkIds.has(q._id.toString()));
    if (unmatchedChunks.length > 0) {
        docData.push({
            section: "Uncategorized Topics",
            topics: [{ title: "General Questions", questions: unmatchedChunks }]
        });
    }

    // 4. Initialize Master PDF Document
    const pdfDoc = await PDFDocument.create();
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // 5. Create Cover Page
    const titlePage = pdfDoc.addPage();
    const { width: tw, height: th } = titlePage.getSize();
    
    titlePage.drawRectangle({
        x: 0, y: 0, width: tw, height: th, color: rgb(0.98, 0.98, 0.99)
    });

    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw, height: 180, color: rgb(0.14, 0.16, 0.28)
    });
    titlePage.drawRectangle({
        x: 0, y: th - 180, width: tw * 0.6, height: 10, color: rgb(0.96, 0.35, 0.14)
    });
    titlePage.drawRectangle({
        x: tw * 0.6, y: th - 180, width: tw * 0.4, height: 10, color: rgb(0.25, 0.51, 0.96)
    });
    
    titlePage.drawText(`UPSC DOCUMENT LIBRARY`, {
      x: 50, y: th - 80, size: 36, font: fontBold, color: rgb(1, 1, 1)
    });
    
    titlePage.drawText(`Comprehensive Question Bank & Extracted Answers`, {
      x: 50, y: th - 120, size: 16, font: fontNormal, color: rgb(0.7, 0.7, 0.8)
    });

    const moduleText = `${subject.replace(/([a-z])([A-Z])/g, '$1 $2').replace('OptionalSubject', 'Optional Subject: ').toUpperCase()} MODULE`;
    
    let fontSize = 48;
    let textWidth = fontBold.widthOfTextAtSize(moduleText, fontSize);
    
    while (textWidth > tw - 100 && fontSize > 24) {
        fontSize -= 2;
        textWidth = fontBold.widthOfTextAtSize(moduleText, fontSize);
    }
    
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

    titlePage.drawRectangle({
        x: 50, y: 150, width: tw - 100, height: 2, color: rgb(0.8, 0.8, 0.8)
    });
    titlePage.drawText(`AI-Generated Knowledge Repository`, {
      x: tw/2 - 130, y: 110, size: 16, font: fontNormal, color: rgb(0.4, 0.4, 0.4)
    });
    titlePage.drawText(`${new Date().getFullYear()} Edition`, {
      x: tw/2 - 35, y: 80, size: 14, font: fontBold, color: rgb(0.14, 0.16, 0.28)
    });

    const indexData = [];

    // 6. Loop and insert divider pages and question pages
    for (const secNode of docData) {
        indexData.push({
            type: 'section',
            text: secNode.section,
            targetPageInternal: pdfDoc.getPageCount()
        });

        const sPage = pdfDoc.addPage();
        sPage.drawRectangle({
            x: 0, y: 0, width: tw, height: th, color: rgb(0.12, 0.14, 0.22)
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

        for (const topNode of secNode.topics) {
            indexData.push({
                type: 'topic',
                text: topNode.title,
                targetPageInternal: pdfDoc.getPageCount()
            });

            for (let qIdx = 0; qIdx < topNode.questions.length; qIdx++) {
                const item = topNode.questions[qIdx];
                const localPath = getLocalPath(item.file_url);

                if (!fs.existsSync(localPath)) {
                    console.warn(`File not found: ${localPath}`);
                    continue;
                }

                const buffer = fs.readFileSync(localPath);
                const sourcePdfDoc = await PDFDocument.load(buffer);
                const sourcePages = await pdfDoc.copyPages(sourcePdfDoc, sourcePdfDoc.getPageIndices());

                if (sourcePages.length > 0) {
                    const p0 = sourcePages[0];
                    const { width: p0w, height: p0h } = p0.getSize();

                    // Cover the question header box area (excluding the topper details at the top)
                    const barHeight = 110;
                    const barY = p0h - barHeight;

                    p0.drawRectangle({
                        x: 0,
                        y: barY,
                        width: p0w,
                        height: 85,
                        color: rgb(0.97, 0.98, 0.99)
                    });

                    // Clean question prefix: e.g. "Q.5a (10 marks): Socio-cultural..." -> "Socio-cultural..."
                    const rawText = item.question_text || "Question text unavailable.";
                    const prefixMatch = rawText.match(/^(?:Q|Question)\.?[ \t]*\d+[a-z]?([ \t]*[([][ \t]*\d+[ \t]*marks[ \t]*[)\]])?[ \t]*[:.-]?[ \t]*/i);
                    let cleanText = rawText;
                    
                    if (prefixMatch) {
                        cleanText = rawText.substring(prefixMatch[0].length).trim();
                    }

                    // Draw wrapped cleaned question text
                    const textMargin = 20;
                    const maxTextWidth = p0w - (textMargin * 2);
                    const qWords = cleanText.replace(/\n/g, ' ').split(' ');
                    let qLine = '';
                    let drawY = p0h - 45;

                    for (const word of qWords) {
                        const testLine = qLine + word + ' ';
                        if (fontBold.widthOfTextAtSize(testLine, 12) > maxTextWidth) {
                            p0.drawText(qLine, { x: textMargin, y: drawY, size: 12, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
                            qLine = word + ' ';
                            drawY -= 18;
                        } else {
                            qLine = testLine;
                        }
                    }
                    p0.drawText(qLine, { x: textMargin, y: drawY, size: 12, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
                }

                sourcePages.forEach(p => pdfDoc.addPage(p));
            }
        }
    }

    // 7. Generate Formal Table of Contents (Index)
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
            idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 1 });
        } else {
            idxPage.drawRectangle({ x: tableX, y: idxY, width: tableW, height: rowH, color: rgb(0.95, 0.97, 1.0), borderColor: rgb(0.7, 0.7, 0.8), borderWidth: 1 });
        }

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

    const mergedPdfBytes = await pdfDoc.save();
    const fileName = `Compiled_Book_Reorder_${id}_${Date.now()}.pdf`;

    const relativeCompiledPath = saveCompiledLocally(Buffer.from(mergedPdfBytes), fileName);
    const compiledUrl = `${req.protocol}://${req.get('host')}${relativeCompiledPath}`;

    record.pdfUrl = compiledUrl;
    await record.save();

    console.log(`[ReorderController] Successfully compiled custom PDF book locally: ${record.pdfUrl}`);
    res.status(200).json({
      message: 'PDF compiled and merged successfully.',
      data: record
    });

  } catch (error) {
    console.error("[ReorderController] Error in compileReorderPdf:", error);
    res.status(500).json({ error: 'Failed to compile reordered PDF.', details: error.message });
  }
};

export const getReorderHistory = async (req, res) => {
  try {
    const history = await ReorderPDF.find({}).sort({ createdAt: -1 });
    res.status(200).json(history);
  } catch (error) {
    console.error("[ReorderController] Error fetching reorder history:", error);
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
};

export const getReorderRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await ReorderPDF.findById(id);
    if (!record) {
      return res.status(404).json({ error: 'Record not found.' });
    }
    res.status(200).json(record);
  } catch (error) {
    console.error("[ReorderController] Error fetching record:", error);
    res.status(500).json({ error: 'Failed to fetch record.' });
  }
};

export const updateReorderRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const { chunks } = req.body;

    if (!chunks || !Array.isArray(chunks)) {
      return res.status(400).json({ error: 'Chunks array is required.' });
    }

    const updated = await ReorderPDF.findByIdAndUpdate(
      id,
      { chunks, pdfUrl: null }, // Reset pdfUrl because the sequence has changed and is now dirty
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    res.status(200).json({
      message: 'Record updated successfully.',
      data: updated
    });
  } catch (error) {
    console.error("[ReorderController] Error updating record:", error);
    res.status(500).json({ error: 'Failed to update record.' });
  }
};

export const deleteReorderRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await ReorderPDF.findById(id);

    if (!record) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    // Delete local chunk files to free up disk space
    if (record.chunks && Array.isArray(record.chunks)) {
      for (const chunk of record.chunks) {
        try {
          const filePath = getLocalPath(chunk.file_url);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          console.warn("[ReorderController] Failed to delete local chunk file during clean up:", e.message);
        }
      }
    }

    // Delete local compiled PDF file if exists
    if (record.pdfUrl) {
      try {
        const compiledPath = getLocalPath(record.pdfUrl);
        if (fs.existsSync(compiledPath)) {
          fs.unlinkSync(compiledPath);
        }
      } catch (e) {
        console.warn("[ReorderController] Failed to delete local compiled PDF during clean up:", e.message);
      }
    }

    await ReorderPDF.findByIdAndDelete(id);
    res.status(200).json({ message: 'Record and local physical files deleted successfully.' });
  } catch (error) {
    console.error("[ReorderController] Error deleting record:", error);
    res.status(500).json({ error: 'Failed to delete record.' });
  }
};
