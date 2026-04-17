import { processPdf } from '../services/pdfProcessingService.js';

export const handlePdfUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Please upload a valid PDF file.' });
    }

    let parsedMetadataList = [{ topperName: 'Unknown Topper' }];
    if (req.body.metadataList) {
      try {
        parsedMetadataList = JSON.parse(req.body.metadataList);
      } catch (e) {
        console.warn("[UploadController] Failed to parse metadataList. Using fallback.");
      }
    }

    console.log(`[UploadController] Received file: ${req.file.originalname}, Sheets specified: ${parsedMetadataList.length}, Size: ${req.file.size} bytes`);
    console.log(`[UploadController] Initiating processPdf...`);
    
    // Pass the memory buffer and metadata array to the service layer
    const results = await processPdf(req.file.buffer, parsedMetadataList);

    console.log(`[UploadController] processPdf completed successfully. Total records generated: ${results.length}`);

    res.status(200).json({
      message: 'PDF successfully processed and analyzed.',
      totalRecords: results.length,
      data: results
    });

  } catch (error) {
    console.error("[UploadController] Upload controller error:", error);
    res.status(500).json({ error: 'Failed to process the uploaded PDF document.', details: error.message });
  }
};
