import { UPSCQA } from '../models/UPSCQA.js';

export const getAllQuestions = async (req, res) => {
  try {
    const questions = await UPSCQA.find({}).sort({ createdAt: -1 });
    res.status(200).json(questions);
  } catch (error) {
    console.error("[DataController] Error fetching questions:", error);
    res.status(500).json({ error: 'Failed to retrieve questions from the database.' });
  }
};

export const updateQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    const { topic, subject } = req.body;

    const updatedQuestion = await UPSCQA.findByIdAndUpdate(
      id,
      { topic, subject },
      { new: true, runValidators: true }
    );

    if (!updatedQuestion) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.status(200).json(updatedQuestion);
  } catch (error) {
    console.error("[DataController] Error updating question:", error);
    res.status(500).json({ error: 'Failed to update question in the database.' });
  }
};
