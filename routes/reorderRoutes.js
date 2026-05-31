import express from 'express';
import multer from 'multer';
import {
  processReorderPdf,
  compileReorderPdf,
  getReorderHistory,
  getReorderRecord,
  updateReorderRecord,
  deleteReorderRecord
} from '../controllers/reorderController.js';

const router = express.Router();

// Setup Multer to store uploaded file buffer in memory
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// POST /api/reorder/process - Upload and process PDF for reordering
router.post('/process', upload.single('pdf'), processReorderPdf);

// GET /api/reorder/history - Retrieve past reorder sequences
router.get('/history', getReorderHistory);

// GET /api/reorder/:id - Retrieve a specific reorder sequence
router.get('/:id', getReorderRecord);

// PUT /api/reorder/:id - Update the sequence ordering or texts
router.put('/:id', updateReorderRecord);

// POST /api/reorder/:id/compile - Merge pages back together and upload
router.post('/:id/compile', compileReorderPdf);

// DELETE /api/reorder/:id - Delete a sequence record
router.delete('/:id', deleteReorderRecord);

export default router;
