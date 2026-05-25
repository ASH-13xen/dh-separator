import express from 'express';
import multer from 'multer';
import { 
  handleQuesPdfUpload, 
  getQuesPdfHistory, 
  updateQuesPdf, 
  deleteQuesPdf 
} from '../controllers/quesPdfController.js';

const router = express.Router();

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// POST /api/quespdf/process - upload and process PDF
router.post('/process', upload.single('pdf'), handleQuesPdfUpload);

// GET /api/quespdf/history - retrieve past uploads
router.get('/history', getQuesPdfHistory);

// PUT /api/quespdf/:id - update questions in db
router.put('/:id', updateQuesPdf);

// DELETE /api/quespdf/:id - delete record
router.delete('/:id', deleteQuesPdf);

export default router;
