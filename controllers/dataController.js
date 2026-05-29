import { UPSCQA } from '../models/UPSCQA.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    const { tags, file_urls } = req.body;

    const updatedQuestion = await UPSCQA.findByIdAndUpdate(
      id,
      { tags, ...(file_urls && { file_urls }) },
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

export const getValidTags = async (req, res) => {
  try {
    const constantsDir = path.join(__dirname, '../constants');
    const files = fs.readdirSync(constantsDir).filter(f => f.endsWith('.json') && f !== 'customHierarchy.json');
    
    const validTags = new Set();
    
    for (const file of files) {
      if (file.startsWith('GS-')) {
         validTags.add(file.replace('.json', ''));
      }
      
      const filePath = path.join(constantsDir, file);
      let data = [];
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        console.error(`Error parsing JSON file ${file} in getValidTags:`, err);
      }
      
      if (Array.isArray(data)) {
         if (file.startsWith('OptionalSubject')) {
            validTags.add(file.replace('.json', ''));
         }
         
         data.forEach(sectionItem => {
           if (sectionItem.section) validTags.add(sectionItem.section);
           if (sectionItem.topics && Array.isArray(sectionItem.topics)) {
             sectionItem.topics.forEach(topicItem => {
               if (topicItem.title) validTags.add(topicItem.title);
             });
           }
         });
      }
    }

    // Merge custom hierarchy tags
    const customPath = path.join(constantsDir, 'customHierarchy.json');
    if (fs.existsSync(customPath)) {
      try {
        const customData = JSON.parse(fs.readFileSync(customPath, 'utf8'));
        if (customData.gsModules) {
          Object.entries(customData.gsModules).forEach(([mod, sections]) => {
            validTags.add(mod);
            sections.forEach(secItem => {
              if (secItem.section) validTags.add(secItem.section);
              if (secItem.topics) {
                secItem.topics.forEach(topicItem => {
                  if (topicItem.title) validTags.add(topicItem.title);
                });
              }
            });
          });
        }
        if (customData.optionalSubjects) {
          Object.entries(customData.optionalSubjects).forEach(([sub, sections]) => {
            validTags.add(sub);
            sections.forEach(secItem => {
              if (secItem.section) validTags.add(secItem.section);
              if (secItem.topics) {
                secItem.topics.forEach(topicItem => {
                  if (topicItem.title) validTags.add(topicItem.title);
                });
              }
            });
          });
        }
      } catch (err) {
        console.error("Error reading custom tags for getValidTags:", err);
      }
    }
    
    res.status(200).json(Array.from(validTags).sort());
  } catch (error) {
    console.error("[DataController] Error fetching valid tags:", error);
    res.status(500).json({ error: 'Failed to retrieve tags from the server.' });
  }
};

export const getHierarchy = async (req, res) => {
  try {
    const constantsDir = path.join(__dirname, '../constants');
    const files = fs.readdirSync(constantsDir).filter(f => f.endsWith('.json') && f !== 'customHierarchy.json');
    
    const hierarchyData = {
      gsModules: {},
      optionalSubjects: {}
    };
    
    for (const file of files) {
      const filePath = path.join(constantsDir, file);
      let structure = [];
      try {
        structure = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        console.error(`Error parsing JSON file ${file} in getHierarchy:`, err);
      }
      
      if (file.startsWith('GS-')) {
         const moduleName = file.replace('.json', '');
         hierarchyData.gsModules[moduleName] = Array.isArray(structure) ? structure : [];
      } else if (file.startsWith('OptionalSubject')) {
         const moduleName = file.replace('.json', '');
         hierarchyData.optionalSubjects[moduleName] = Array.isArray(structure) ? structure : [];
      }
    }

    // Merge custom hierarchy if exists
    const customPath = path.join(constantsDir, 'customHierarchy.json');
    if (fs.existsSync(customPath)) {
      try {
        const customData = JSON.parse(fs.readFileSync(customPath, 'utf8'));
        if (customData.gsModules) {
          Object.entries(customData.gsModules).forEach(([mod, sections]) => {
            if (!hierarchyData.gsModules[mod]) {
              hierarchyData.gsModules[mod] = [];
            }
            sections.forEach(secObj => {
              const existingSec = hierarchyData.gsModules[mod].find(s => s.section === secObj.section);
              if (!existingSec) {
                hierarchyData.gsModules[mod].push({
                  section: secObj.section,
                  topics: secObj.topics ? [...secObj.topics] : []
                });
              } else {
                if (secObj.topics) {
                  secObj.topics.forEach(topObj => {
                    const existingTop = existingSec.topics.find(t => t.title === topObj.title);
                    if (!existingTop) {
                      existingSec.topics.push({ title: topObj.title });
                    }
                  });
                }
              }
            });
          });
        }
        
        if (customData.optionalSubjects) {
          Object.entries(customData.optionalSubjects).forEach(([sub, sections]) => {
            if (!hierarchyData.optionalSubjects[sub]) {
              hierarchyData.optionalSubjects[sub] = [];
            }
            sections.forEach(secObj => {
              const existingSec = hierarchyData.optionalSubjects[sub].find(s => s.section === secObj.section);
              if (!existingSec) {
                hierarchyData.optionalSubjects[sub].push({
                  section: secObj.section,
                  topics: secObj.topics ? [...secObj.topics] : []
                });
              } else {
                if (secObj.topics) {
                  secObj.topics.forEach(topObj => {
                    const existingTop = existingSec.topics.find(t => t.title === topObj.title);
                    if (!existingTop) {
                      existingSec.topics.push({ title: topObj.title });
                    }
                  });
                }
              }
            });
          });
        }
      } catch (err) {
        console.error("Error reading custom hierarchy:", err);
      }
    }
    
    res.status(200).json(hierarchyData);
  } catch (error) {
    console.error("[DataController] Error fetching hierarchy:", error);
    res.status(500).json({ error: 'Failed to retrieve hierarchy.' });
  }
};

export const addCustomTag = async (req, res) => {
  try {
    const { type, name, parentModule, parentSection } = req.body;
    if (!type || !name) {
      return res.status(400).json({ error: "Type and name are required." });
    }
    
    const constantsDir = path.join(__dirname, '../constants');
    
    // Resolve module/subject name
    let moduleName = '';
    if (type === 'gsModule' || type === 'optionalSubject') {
      moduleName = name;
    } else {
      moduleName = parentModule;
    }
    
    if (!moduleName) {
      return res.status(400).json({ error: "parentModule is required for sections and topics." });
    }
    
    // Normalize optional subject name to start with OptionalSubject
    if (type.startsWith('optional')) {
      if (!moduleName.startsWith('OptionalSubject')) {
        const cleanName = moduleName.replace(/\s+/g, '');
        moduleName = `OptionalSubject${cleanName.charAt(0).toUpperCase()}${cleanName.slice(1)}`;
      }
    }
    
    const filePath = path.join(constantsDir, `${moduleName}.json`);
    
    let data = [];
    if (fs.existsSync(filePath)) {
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        console.error(`Error parsing existing file ${moduleName}.json:`, err);
      }
    }
    
    if (type === 'gsModule' || type === 'optionalSubject') {
      if (!Array.isArray(data)) {
        data = [];
      }
    } else if (type === 'gsSection' || type === 'optionalSection') {
      if (!Array.isArray(data)) data = [];
      const existingSec = data.find(s => s.section === name);
      if (!existingSec) {
        data.push({ section: name, topics: [] });
      }
    } else if (type === 'gsTopic' || type === 'optionalTopic') {
      if (!parentSection) {
        return res.status(400).json({ error: "parentSection is required for topics." });
      }
      if (!Array.isArray(data)) data = [];
      let existingSec = data.find(s => s.section === parentSection);
      if (!existingSec) {
        existingSec = { section: parentSection, topics: [] };
        data.push(existingSec);
      }
      if (!existingSec.topics) existingSec.topics = [];
      const existingTop = existingSec.topics.find(t => t.title === name);
      if (!existingTop) {
        existingSec.topics.push({ title: name, subtopics: [] });
      }
    }
    
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    
    res.status(200).json({ success: true, name: moduleName });
  } catch (error) {
    console.error("[DataController] Error adding custom tag:", error);
    res.status(500).json({ error: 'Failed to add custom tag.' });
  }
};
