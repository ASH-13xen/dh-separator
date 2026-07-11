import express from 'express';
import {
  listUsedSubjects,
  listRegistrySubjects,
  generateSyllabusText,
  classifySubject,
  activateSubject,
  reclassifySubject,
  previewSubjectBookData,
  generateSubjectBookPdf,
  getSubjectBookStatus,
  downloadSubjectBook,
  cleanupSubjectBookStorage,
  previewSubjectTopperFile,
  saveSubjectBookLayout
} from '../controllers/subjectController.js';

const router = express.Router();

// Subject Setup
router.get('/used', listUsedSubjects);
router.get('/registry', listRegistrySubjects);
router.post('/generate-syllabus', generateSyllabusText);
router.post('/classify', classifySubject);
router.post('/:slug/activate', activateSubject);
router.post('/:slug/reclassify', reclassifySubject);

// Generic book-compilation pipeline (parameterized clone of /api/psir)
router.get('/:slug/preview', previewSubjectBookData);
router.post('/:slug/layout', saveSubjectBookLayout);
router.post('/:slug/generate', generateSubjectBookPdf);
router.get('/:slug/status/:id', getSubjectBookStatus);
router.get('/:slug/download/:id', downloadSubjectBook);
router.post('/:slug/cleanup-storage', cleanupSubjectBookStorage);
router.get('/:slug/preview-file', previewSubjectTopperFile);

export default router;
