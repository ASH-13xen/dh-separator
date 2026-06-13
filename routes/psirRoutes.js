import express from 'express';
import { previewPsirData, generatePsirPdf, getPsirBookStatus, downloadPsirBook } from '../controllers/psirController.js';

const router = express.Router();

// GET /api/psir/preview
router.get('/preview', previewPsirData);

// POST /api/psir/generate
router.post('/generate', generatePsirPdf);

// GET /api/psir/status/:id
router.get('/status/:id', getPsirBookStatus);

// GET /api/psir/download/:id
router.get('/download/:id', downloadPsirBook);

export default router;
