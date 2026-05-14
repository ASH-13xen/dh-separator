import { processPdf } from '../services/pdfProcessingService.js';
import { UPSCQA } from '../models/UPSCQA.js';
import streamifier from 'streamifier';
import { v2 as cloudinary } from 'cloudinary';

const uploadToCloudinary = (buffer, fileName) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: 'upsc_answers', public_id: fileName },
      (error, result) => {
        if (result) resolve(result.secure_url);
        else reject(error);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
};

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
    if (error.message === 'LOCATION_NOT_SUPPORTED' || (error.message && error.message.includes('User location is not supported'))) {
      return res.status(403).json({ 
        error: 'Google Gemini API is restricted in the server\'s current location. Please deploy the server to a supported region (e.g. US Oregon) or use a proxy.' 
      });
    }
    res.status(500).json({ error: 'Failed to process the uploaded PDF document.', details: error.message });
  }
};

export const handleManualUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    const { question_text, topper_name, topper_year, topper_rank, topper_marks, tags } = req.body;
    if (!question_text) {
      return res.status(400).json({ error: 'Question text is required.' });
    }

    let parsedTags = [];
    if (tags) {
      try {
        parsedTags = JSON.parse(tags);
      } catch (e) {
        // fallback
      }
    }

    const fileNameObj = `Manual_${Date.now()}`; 
    const file_url = await uploadToCloudinary(req.file.buffer, fileNameObj);

    const result = await UPSCQA.findOneAndUpdate(
      { question_text },
      {
        $setOnInsert: {
          tags: parsedTags,
          start_page: 1,
          end_page: 1
        },
        $push: {
          file_urls: {
            url: file_url,
            topper_name: topper_name || 'Unknown Topper',
            topper_year: topper_year || '',
            topper_rank: topper_rank || '',
            topper_marks: topper_marks || ''
          }
        }
      },
      { upsert: true, new: true }
    );

    res.status(200).json({
      message: 'Manual question uploaded successfully.',
      data: result
    });
  } catch (error) {
    console.error("[UploadController] Manual upload error:", error);
    res.status(500).json({ error: 'Failed to upload manual question.', details: error.message });
  }
};

export const updateTopperDetails = async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates)) {
      return res.status(400).json({ error: 'Updates array is required.' });
    }

    const bulkOps = updates.map(update => ({
      updateMany: {
        filter: { 'file_urls.url': update.file_url },
        update: {
          $set: {
            'file_urls.$[elem].topper_name': update.topper_name || 'Unknown Topper',
            'file_urls.$[elem].topper_year': update.topper_year || '',
            'file_urls.$[elem].topper_rank': update.topper_rank || '',
            'file_urls.$[elem].topper_marks': update.topper_marks || ''
          }
        },
        arrayFilters: [{ 'elem.url': update.file_url }]
      }
    }));

    if (bulkOps.length > 0) {
      await UPSCQA.bulkWrite(bulkOps);
    }

    res.status(200).json({ message: 'Topper details updated successfully.' });
  } catch (error) {
    console.error("[UploadController] Error updating topper details:", error);
    res.status(500).json({ error: 'Failed to update topper details.' });
  }
};