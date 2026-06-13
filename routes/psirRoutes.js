import express from 'express';
import { previewPsirData, generatePsirPdf, getPsirBookStatus } from '../controllers/psirController.js';

const router = express.Router();

// GET /api/psir/preview
router.get('/preview', previewPsirData);

// POST /api/psir/generate
router.post('/generate', generatePsirPdf);

// GET /api/psir/status/:id
router.get('/status/:id', getPsirBookStatus);

export default router;
