import express from 'express';
import {
  listUsedSubjects,
  listRegistrySubjects,
  generateSyllabusText,
  classifySubject,
  activateSubject,
  reclassifySubject,
  listSubjectToppers,
  previewSubjectBookData,
  generateSubjectBookPdf,
  generateCollectiveSubjectBookPdf,
  getSubjectBookStatus,
  downloadSubjectBook,
  cleanupSubjectBookStorage,
  previewSubjectTopperFile,
  saveSubjectBookLayout,
  listUploadBatches,
  updateUploadBatch,
  deleteUploadBatch
} from '../controllers/subjectController.js';

const router = express.Router();

// Subject Setup
router.get('/used', listUsedSubjects);
router.get('/registry', listRegistrySubjects);
router.post('/generate-syllabus', generateSyllabusText);
router.post('/classify', classifySubject);
router.post('/:slug/activate', activateSubject);
router.post('/:slug/reclassify', reclassifySubject);
router.get('/:slug/toppers', listSubjectToppers);

// All Uploads admin view — one row per upload action: reassign its subject / rename its
// topper(s) / delete it entirely (and every question that has no other answer sheet left).
router.get('/uploads/batches', listUploadBatches);
router.put('/uploads/batches/:batchKey', updateUploadBatch);
router.delete('/uploads/batches/:batchKey', deleteUploadBatch);

// Generic book-compilation pipeline (parameterized clone of /api/psir)
router.get('/:slug/preview', previewSubjectBookData);
router.post('/:slug/layout', saveSubjectBookLayout);
router.post('/:slug/generate', generateSubjectBookPdf);
router.post('/:slug/generate-collective', generateCollectiveSubjectBookPdf);
router.get('/:slug/status/:id', getSubjectBookStatus);
router.get('/:slug/download/:id', downloadSubjectBook);
router.post('/:slug/cleanup-storage', cleanupSubjectBookStorage);
router.get('/:slug/preview-file', previewSubjectTopperFile);

export default router;
