import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const UPSC_SYLLABUS = `
PART-B: MAIN EXAMINATION - COMPULSORY PAPERS
Paper-II (General Studies-I): Indian Heritage and Culture, History and Geography of the World and Society.
Paper-III (General Studies-II): Governance, Constitution, Polity, Social Justice and International relations.
Paper-IV (General Studies-III): Technology, Economic Development, Bio diversity, Environment, Security and Disaster Management.
Paper-V (General Studies-IV): Ethics, Integrity, and Aptitude.

OPTIONAL SUBJECTS (PAPER-VI & PAPER-VII)
1. AGRICULTURE
Paper I: Ecology and environment, Cropping patterns and farming systems, Forestry plantations, Weeds and control, Soil science and conservation, Water-use efficiency and irrigation, Farm management and economics, Agricultural extension.
Paper II: Cell biology and Genetics, Plant breeding, Seed production and technologies, Plant Physiology, Horticulture and plant crops, Pest and disease management, Food production and consumption trends.
2. ANIMAL HUSBANDRY AND VETERINARY SCIENCE
Paper I: Animal Nutrition, Animal Physiology, Animal Reproduction, Livestock Production and Management, Genetics and Animal Breeding, Extension.
Paper II: Anatomy, Pharmacology and Hygiene; Animal Diseases; Veterinary Public Health; Milk and Milk Products Technology; Meat Hygiene and Technology.
3. ANTHROPOLOGY
Paper I: Meaning/Scope of Anthropology, Human Evolution and Primates, Prehistoric Archaeology, Nature of Culture and Society, Marriage, Family, Kinship, Economic/Political Organization, Religion, Anthropological theories, Culture and Language, Research methods, Human Genetics/Demography, Concept of human growth, Applications of Anthropology.
Paper II: Evolution of Indian Culture and Civilization, Demographic profile of India, Traditional Indian social system (Caste system), Emergence of anthropology in India, Indian Village system, Tribal situation and problems, Social change/Movements among tribal societies.
4. BOTANY
Paper I: Microbiology and Plant Pathology, Cryptogams, Phanerogams, Plant Resource Development, Morphogenesis.
Paper II: Cell Biology, Genetics/Molecular Biology/Evolution, Plant Breeding/Biotechnology/Biostatistics, Physiology and Biochemistry, Ecology and Plant Geography.
5. CHEMISTRY
Paper I: Atomic Structure, Chemical Bonding, Solid State, Gaseous State and Transport Phenomenon, Liquid State, Thermodynamics, Phase Equilibria and Solutions, Electrochemistry, Chemical Kinetics, Photochemistry, Surface Phenomena and Catalysis, Bio-inorganic Chemistry, Coordination Compounds, Main Group Chemistry, General Chemistry of ‘f’ Block Elements.
Paper II: Delocalised Covalent Bonding, Reaction Mechanisms, Pericyclic Reactions, Polymers, Synthetic Uses of Reagents, Photochemistry, Spectroscopy.
6. CIVIL ENGINEERING
Paper I: Engineering Mechanics, Strength of Materials, Structural Analysis, Design of Structures (Steel, Concrete, Masonry), Fluid Mechanics, Open Channel Flow, Hydraulic Machines, Geotechnical Engineering.
Paper II: Construction Technology/Equipment/Planning and Management, Surveying and Transportation Engineering, Hydrology/Water Resources/Engineering, Environmental Engineering, Environmental pollution.
7. COMMERCE AND ACCOUNTANCY
Paper I: Accounting, Taxation & Auditing (Financial Accounting, Cost Accounting, Taxation, Auditing); Financial Management, Financial Institutions and Markets.
Paper II: Organisation Theory and Behaviour, Human Resource Management and Industrial Relations.
8. ECONOMICS
Paper I: Advanced Micro Economics, Advanced Macro Economics, Money-Banking and Finance, International Economics, Growth and Development.
Paper II: Indian Economy in Pre-Independence Era, Indian Economy after Independence (Pre-Liberalization and Post-Liberalization Eras).
9. ELECTRICAL ENGINEERING
Paper I: Circuit Theory, Signals & Systems, E.M. Theory, Analog Electronics, Digital Electronics, Energy Conversion, Power Electronics and Electric Drives, Analog Communication.
Paper II: Control Systems, Microprocessors and Microcomputers, Measurement and Instrumentation, Power Systems: Analysis and Control, Power System Protection, Digital Communication.
10. GEOGRAPHY
Paper I (Principles of Geography): Physical Geography (Geomorphology, Climatology, Oceanography, Biogeography, Environmental Geography), Human Geography (Perspectives, Economic Geography, Population and Settlement, Regional Planning, Models/Theories/Laws).
Paper II (Geography of India): Physical Setting, Resources, Agriculture, Industry, Transport/Communication/Trade, Cultural Setting, Settlements, Regional Development and Planning, Political Aspects, Contemporary Issues.
11. GEOLOGY
Paper I: General Geology, Geomorphology and Remote Sensing, Structural Geology, Paleontology, Indian Stratigraphy, Hydrogeology and Engineering Geology.
Paper II: Mineralogy, Igneous and Metamorphic Petrology, Sedimentary Petrology, Economic Geology, Mining Geology, Geochemistry and Environmental Geology.
12. HISTORY
Paper I: Sources, Pre-history/Proto-history, Indus Valley Civilization, Megalithic Cultures, Aryans and Vedic Period, Mahajanapadas, Mauryan Empire, Post-Mauryan Period, Early State/Society in Eastern/South India, Guptas/Vakatakas/Vardhanas, Regional States (Gupta Era), Themes in Early Indian Cultural History, Early Medieval India (750-1200), Cultural Traditions (750-1200), The Thirteenth/Fourteenth Centuries, Society/Culture/Economy (13th-14th C), Fifteenth/Sixteenth Centuries, Akbar, Mughal Empire (17th C), Economy/Society/Culture in Mughal Era, The Eighteenth Century.
Paper II: European Penetration into India, British Expansion, Early Structure of the British Raj, Economic Impact of British Rule, Social/Cultural/Religious Reforms, Indian Response to British Rule, Indian National Congress/Nationalism, Rise of Gandhi, Constitutional Developments, Revolutionaries/Left Movements, Separatism and Partition, Post-1947 Consolidation, Enlightenment and Modern ideas, Origins of Modern Politics, Industrialization, Nation-State System, Imperialism/Colonialism, Revolutions, World Wars, World after WWII, Decolonization, Unification of Europe, Disintegration of Soviet Union.
13. LAW
Paper I: Constitutional and Administrative Law, International Law.
Paper II: Law of Crimes, Law of Torts, Law of Contracts and Mercantile Law, Contemporary Legal Developments.
14. MANAGEMENT
Paper I: Managerial Function and Process, Organisational Behaviour and Design, Human Resource Management, Accounting for Managers, Financial Management, Marketing Management.
Paper II: Quantitative Techniques in Decision Making, Production and Operations Management, Management Information System, Government Business Interface, Strategic Management, International Business.
15. MATHEMATICS
Paper I: Linear Algebra, Calculus, Analytic Geometry, Ordinary Differential Equations, Dynamics & Statics, Vector Analysis.
Paper II: Algebra, Real Analysis, Complex Analysis, Linear Programming, Partial differential equations, Numerical Analysis and Computer programming, Mechanics and Fluid Dynamics.
16. MECHANICAL ENGINEERING
Paper I: Mechanics (Rigid and Deformable bodies), Engineering Materials, Theory of Machines, Manufacturing Science (Process and Management).
Paper II: Thermodynamics/Gas Dynamics/Turbines, Heat Transfer, I.C. Engines, Steam Engineering, Refrigeration and air-conditioning.
17. MEDICAL SCIENCE
Paper I: Human Anatomy, Human Physiology, Biochemistry, Pathology, Microbiology, Pharmacology, Forensic Medicine and Toxicology.
Paper II: General Medicine, Pediatrics, Dermatology, General Surgery, Obstetrics and Gynaecology including Family Planning, Community Medicine (Preventive and Social Medicine).
18. PHILOSOPHY
Paper I (History and Problems of Philosophy): Plato, Aristotle, Rationalism, Empiricism, Kant, Hegel, Moore/Russell/Wittgenstein, Logical Positivism, Phenomenology, Existentialism, Quine/Strawson, Cârvâka, Jainism, Buddhism, Nyâya-Vaiúesika, Sâmkhya, Yoga, Mimâmsâ, Vedânta, Aurobindo.
Paper II: Socio-Political Philosophy, Philosophy of Religion.
19. PHYSICS
Paper I: Mechanics of Particles/Rigid Bodies/Continuous Media, Special Relativity, Waves and Optics, Electricity and Magnetism, Electromagnetic Waves and Blackbody Radiation, Thermal and Statistical Physics.
Paper II: Quantum Mechanics, Atomic and Molecular Physics, Nuclear and Particle Physics, Solid State Physics, Devices and Electronics.
20. POLITICAL SCIENCE AND INTERNATIONAL RELATIONS
Paper I: Political Theory (Theories of State, Justice, Equality, Rights, Democracy, Ideologies), Indian Political Thought, Western Political Thought, Indian Government and Politics (Nationalism, Constitution, Organs of Govt, Grassroots Democracy, Federalism, Party System, Social Movements).
Paper II: Comparative Politics and International Relations (State in comparative perspective, Globalization, Approaches to IR, Changing International Order, UN, Regionalization), India and the World (Foreign Policy, NAM, SAARC, Global South, Nuclear Question).
21. PSYCHOLOGY
Paper I (Foundations of Psychology): Introduction, Methods, Research Methods, Development of Human Behaviour, Sensation/Attention/Perception, Learning, Memory, Thinking and Problem Solving, Motivation and Emotion, Intelligence and Aptitude, Personality, Attitudes/Values/Interests, Language and Communication, Issues and Perspectives in Modern Psychology.
Paper II (Psychology: Issues and Applications): Measurement of Individual Differences, Psychological well being/Mental Disorders, Therapeutic Approaches, Work/Organisational Behaviour, Educational Applications, Community Psychology, Rehabilitation Psychology, Disadvantaged Groups, Social Integration, IT/Mass Media, Economic Development, Environmental Psychology, Military/Sports/Gender Psychology.
22. PUBLIC ADMINISTRATION
Paper I (Administrative Theory): Introduction, Administrative Thought, Administrative Behaviour, Organisations, Accountability and Control, Administrative Law, Comparative PA, Development Dynamics, Personnel Administration, Public Policy, Techniques of Administrative Improvement, Financial Administration.
Paper II (Indian Administration): Evolution, Philosophical/Constitutional framework, Public Sector Undertakings, Union Government and Administration, Plans and Priorities, State Government, District Administration, Civil Services, Financial Management, Administrative Reforms, Rural/Urban Local Government, Law and Order Administration.
23. SOCIOLOGY
Paper I (Fundamentals of Sociology): Sociology as a Discipline, Sociology as Science, Research Methods and Analysis, Sociological Thinkers (Marx, Durkheim, Weber, Parsons, Merton, Mead), Stratification and Mobility, Works and Economic Life, Politics and Society, Religion and Society, Systems of Kinship, Social Change in Modern Society.
Paper II (Indian Society: Structure and Change): Introducing Indian Society (Perspectives, Colonial Impact), Social Structure (Rural/Agrarian, Caste System, Tribal communities, Social Classes, Kinship, Religion), Social Changes in India (Visions of change, Rural/Agrarian transformation, Industrialization/Urbanization, Politics/Society, Social Movements, Population Dynamics, Challenges of Transformation).
24. STATISTICS
Paper I: Probability, Statistical Inference, Linear Inference and Multivariate Analysis, Sampling Theory and Design of Experiments.
Paper II: Industrial Statistics, Optimization Techniques, Quantitative Economics and Official Statistics, Demography and Psychometry.
25. ZOOLOGY
Paper I: Non-chordata and Chordata, Ecology, Ethology, Economic Zoology, Biostatistics, Instrumentation Methods.
Paper II: Cell Biology, Genetics, Evolution, Systematics, Biochemistry, Physiology, Developmental Biology.
`;

// Strict list of allowed subjects. Gemini MUST pick one of these.
const ALLOWED_SUBJECTS = [
  "General Studies-I", "General Studies-II", "General Studies-III", "General Studies-IV",
  "AGRICULTURE", "ANIMAL HUSBANDRY AND VETERINARY SCIENCE", "ANTHROPOLOGY", "BOTANY", 
  "CHEMISTRY", "CIVIL ENGINEERING", "COMMERCE AND ACCOUNTANCY", "ECONOMICS", 
  "ELECTRICAL ENGINEERING", "GEOGRAPHY", "GEOLOGY", "HISTORY", "LAW", "MANAGEMENT", 
  "MATHEMATICS", "MECHANICAL ENGINEERING", "MEDICAL SCIENCE", "PHILOSOPHY", "PHYSICS", 
  "POLITICAL SCIENCE AND INTERNATIONAL RELATIONS", "PSYCHOLOGY", "PUBLIC ADMINISTRATION", 
  "SOCIOLOGY", "STATISTICS", "ZOOLOGY"
];

export const processEntirePdfWithGemini = async (pdfBuffer) => {
  const tempFilePath = path.join(os.tmpdir(), `full-doc-${Date.now()}.pdf`);

  try {
    fs.writeFileSync(tempFilePath, pdfBuffer);
    
    console.log(`[GeminiService] Uploading file to Google AI...`);
    const uploadResult = await fileManager.uploadFile(tempFilePath, {
      mimeType: 'application/pdf',
      displayName: `UPSC Complete Document`,
    });

    // Wait for the file to be processed by Google's servers
    let fileInfo = await fileManager.getFile(uploadResult.file.name);
    while (fileInfo.state === 'PROCESSING') {
      console.log(`[GeminiService] File is processing... waiting 5 seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fileInfo = await fileManager.getFile(uploadResult.file.name);
    }

    // UPDATED PROMPT: Explicitly instructing it to combine papers and use root subject names
    const prompt = `You are an expert UPSC document classifier. 
Scan the attached document and identify every explicitly marked question. 
Classify them STRICTLY according to the official UPSC syllabus provided below.

--- OFFICIAL UPSC SYLLABUS ---
${UPSC_SYLLABUS}
------------------------------

For every question found, provide:
1. 'question_text': The exact full text of the question.
2. 'subject': The EXACT main subject name from the syllabus. DO NOT include "Paper I" or "Paper II" in the subject name (e.g., use "HISTORY", not "History Paper 1").
3. 'topic': The exact best-fit sub-topic from the syllabus. You must pick the topic from EITHER Paper I or Paper II under that main subject.
4. 'start_page': The exact physical page number where it starts (Page 1 is the first page).
5. 'end_page': The exact physical page number where the answer ends.

RULES:
- You MUST select the 'subject' from the exact predefined schema list.
- Return ONLY a JSON array.`;

    // UPDATED SCHEMA: Using Enum to force Gemini into strict subject matching
    const responseSchema = {
      type: SchemaType.ARRAY,
      description: "Array of classified questions",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          question_text: { type: SchemaType.STRING },
          subject: { 
            type: SchemaType.STRING,
            enum: ALLOWED_SUBJECTS, // This strictly enforces the subject names!
            description: "The main subject name, strictly matching the allowed list. Never include paper numbers."
          },
          topic: { type: SchemaType.STRING },
          start_page: { type: SchemaType.INTEGER },
          end_page: { type: SchemaType.INTEGER }
        },
        required: ["question_text", "subject", "topic", "start_page", "end_page"]
      }
    };

    console.log(`[GeminiService] Initializing AI analysis...`);
    const result = await model.generateContent({
      contents: [{ 
        role: 'user', 
        parts: [
          { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } },
          { text: prompt }
        ] 
      }],
      generationConfig: { 
        responseMimeType: "application/json", 
        responseSchema: responseSchema, 
        temperature: 0.0 // Keep this at 0.0 for maximum consistency
      }
    });
    
    const responseText = result.response.text();
    const jsonArray = JSON.parse(responseText);
    
    // Clean up
    try { await fileManager.deleteFile(uploadResult.file.name); } catch (e) {}
    
    return jsonArray;

  } catch (error) {
    console.error("[GeminiService] Error:", error);
    throw error;
  } finally {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
  }
};