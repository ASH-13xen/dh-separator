import express from 'express';
import { getAllQuestions, updateQuestion, getValidTags, getHierarchy, addCustomTag } from '../controllers/dataController.js';

const router = express.Router();

router.get('/questions', getAllQuestions);
router.put('/questions/:id', updateQuestion);
router.get('/tags', getValidTags);
router.get('/hierarchy', getHierarchy);
router.post('/hierarchy/custom', addCustomTag);

export default router;
