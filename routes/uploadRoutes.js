import express from 'express';
import multer from 'multer';
import { handlePdfUpload, handleManualUpload } from '../controllers/uploadController.js';

const router = express.Router();

import os from 'os';

// Setup Multer to store uploaded file on disk instead of memory
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, os.tmpdir());
  },
  filename: function (req, file, cb) {
    cb(null, `upload-${Date.now()}-${Math.round(Math.random() * 1E9)}.pdf`);
  }
});

const upload = multer({
  storage: storage,
  // limits: { fileSize: 50 * 1024 * 1024 } 
});

// POST /api/upload route
router.post('/upload', upload.single('pdf'), handlePdfUpload);

// POST /api/upload/manual route
router.post('/upload/manual', upload.single('pdf'), handleManualUpload);

// POST /api/upload/update-toppers route
import { updateTopperDetails } from '../controllers/uploadController.js';
router.post('/upload/update-toppers', updateTopperDetails);

export default router;
