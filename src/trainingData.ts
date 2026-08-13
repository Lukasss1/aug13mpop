import { TrainingAssessment } from './types';
import { module1Slides } from './slidesData';
import { FOOD_SAFETY_MODULES } from './trainingFoodSafety';

export const INITIAL_ASSESSMENTS: TrainingAssessment[] = [
  // Food hygiene, temperature, allergen and cleaning curriculum (fs1–fs4).
  ...FOOD_SAFETY_MODULES,
  {
    "id": "a1",
    "title": "Module 1: Welcome to Milk Pop",
    "description": "It introduces every new team member to the heart of Milk Pop: our purpose, our standards, our customers, our working environment, and the role each person plays in helping the brand grow.",
    "learningObjectives": [
      "Milkshake-led brand identity",
      "Premium-cute positioning",
      "Shopping centre customer experience",
      "Customer promise",
      "Store atmosphere",
      "Tone of service",
      "Visual presentation",
      "Staff behaviour expectations"
    ],
    "passingScore": 85,
    "category": "brand",
    "slides": module1Slides,
    "points": 500,
    "badge": "Ambassador Badge",
    "questions": [
      {
        "id": "q1",
        "text": "A customer is standing near the kiosk and reading the menu. They look interested but unsure. A queue is beginning to form behind them. What is the most professional response?",
        "type": "multiple_choice",
        "options": [
          "Wait silently until they decide.",
          "Ask them to choose quickly because other customers are waiting.",
          "Offer a simple recommendation and help them decide calmly.",
          "Ignore them and focus on preparing the next order."
        ],
        "correctAnswer": "Offer a simple recommendation and help them decide calmly.",
        "explanation": "Milk Pop service must protect both speed and customer comfort. A good recommendation helps the customer decide without making them feel rushed.",
        "difficulty": "medium",
        "categoryTag": "Customer Service"
      },
      {
        "id": "q2",
        "text": "What does “simple for the customer, professional behind the counter” mean?",
        "type": "multiple_choice",
        "options": [
          "Customers should not notice any standards.",
          "The experience should feel easy because the team is trained and organised.",
          "Staff can ignore procedures if customers seem happy.",
          "The brand should avoid professional systems."
        ],
        "correctAnswer": "The experience should feel easy because the team is trained and organised.",
        "explanation": "The customer experience should feel simple because staff follow clear standards.",
        "difficulty": "medium",
        "categoryTag": "Brand Promise"
      },
      {
        "id": "q3",
        "text": "Which action best supports Milk Pop’s long-term growth?",
        "type": "multiple_choice",
        "options": [
          "Serving quickly even if products look messy.",
          "Giving every customer a clean, easy and consistent experience.",
          "Only focusing on customers who spend more.",
          "Avoiding recommendations to keep the queue short."
        ],
        "correctAnswer": "Giving every customer a clean, easy and consistent experience.",
        "explanation": "Consistent positive experiences create trust, repeat visits and brand growth.",
        "difficulty": "medium",
        "categoryTag": "Growth"
      },
      {
        "id": "q4",
        "text": "A staff member says, “It is only a milkshake, presentation does not really matter.” What does this show?",
        "type": "multiple_choice",
        "options": [
          "They understand that speed is always more important.",
          "They do not yet understand that presentation affects customer trust and brand perception.",
          "They are correct because customers only care about taste.",
          "They should only care about presentation when a manager is watching."
        ],
        "correctAnswer": "They do not yet understand that presentation affects customer trust and brand perception.",
        "explanation": "Product presentation is part of the Milk Pop standard.",
        "difficulty": "medium",
        "categoryTag": "Standards"
      },
      {
        "id": "q5",
        "text": "During a busy period, what is the best sign of professional composure?",
        "type": "multiple_choice",
        "options": [
          "Moving as fast as possible without speaking.",
          "Staying calm, communicating clearly and checking accuracy.",
          "Avoiding eye contact with customers.",
          "Letting the queue pressure control your behaviour."
        ],
        "correctAnswer": "Staying calm, communicating clearly and checking accuracy.",
        "explanation": "Composure protects accuracy, service and team control.",
        "difficulty": "medium",
        "categoryTag": "Pressure"
      },
      {
        "id": "q6",
        "text": "A customer asks if a product contains nuts. You are almost sure, but not completely certain. What should you do?",
        "type": "multiple_choice",
        "options": [
          "Say no because you are almost sure.",
          "Say it should be fine.",
          "Check the allergen information properly before confirming.",
          "Ask another new staff member to guess."
        ],
        "correctAnswer": "Check the allergen information properly before confirming.",
        "explanation": "Staff must never guess allergen information.",
        "difficulty": "medium",
        "categoryTag": "Safety"
      },
      {
        "id": "q7",
        "text": "Which statement best describes the physical reality of the role?",
        "type": "multiple_choice",
        "options": [
          "The role is easy because the menu is simple.",
          "The role can involve standing, moving quickly, cleaning, restocking and staying alert.",
          "Physical safety only matters during closing.",
          "Staff should ignore discomfort to show commitment."
        ],
        "correctAnswer": "The role can involve standing, moving quickly, cleaning, restocking and staying alert.",
        "explanation": "Shopping centre kiosk work can be physically active and requires safe working habits.",
        "difficulty": "medium",
        "categoryTag": "Physical Reality"
      },
      {
        "id": "q8",
        "text": "Why is emotional control important at Milk Pop?",
        "type": "multiple_choice",
        "options": [
          "Because staff must hide their personality.",
          "Because busy service, complaints and pressure require calm responses.",
          "Because customers are always difficult.",
          "Because emotions should never be discussed."
        ],
        "correctAnswer": "Because busy service, complaints and pressure require calm responses.",
        "explanation": "Emotional control helps staff stay professional in real service situations.",
        "difficulty": "medium",
        "categoryTag": "Emotional Control"
      },
      {
        "id": "q9",
        "text": "Which action shows ownership?",
        "type": "multiple_choice",
        "options": [
          "Waiting for a manager to notice every problem.",
          "Fixing or reporting issues early before they affect customers.",
          "Blaming the previous shift.",
          "Only helping when asked directly."
        ],
        "correctAnswer": "Fixing or reporting issues early before they affect customers.",
        "explanation": "Ownership means protecting the shift before problems grow.",
        "difficulty": "medium",
        "categoryTag": "Ownership"
      },
      {
        "id": "q10",
        "text": "A customer says, “I am not sure what to get. I like chocolate.” What is the best response?",
        "type": "multiple_choice",
        "options": [
          "\"Just choose something.\"",
          "\"Kinder Bueno, Oreo or Ferrero Rocher may be good choices if you like chocolate.\"",
          "\"Everything is the same.\"",
          "\"I do not know what you like.\""
        ],
        "correctAnswer": "\"Kinder Bueno, Oreo or Ferrero Rocher may be good choices if you like chocolate.\"",
        "explanation": "A clear recommendation helps the customer choose confidently.",
        "difficulty": "medium",
        "categoryTag": "Customer Service"
      },
      {
        "id": "q11",
        "text": "Which behaviour damages trust the fastest?",
        "type": "multiple_choice",
        "options": [
          "Asking for help when unsure.",
          "Checking the order before making it.",
          "Guessing information when unsure.",
          "Greeting a customer politely."
        ],
        "correctAnswer": "Guessing information when unsure.",
        "explanation": "Guessing can create mistakes, safety risks and loss of trust.",
        "difficulty": "medium",
        "categoryTag": "Trust"
      },
      {
        "id": "q12",
        "text": "What should staff do when pressure increases?",
        "type": "multiple_choice",
        "options": [
          "Stop communicating.",
          "Rush without checking.",
          "Focus on the next clear task and communicate early.",
          "Ignore the queue completely."
        ],
        "correctAnswer": "Focus on the next clear task and communicate early.",
        "explanation": "Structure and communication help manage pressure.",
        "difficulty": "medium",
        "categoryTag": "Pressure"
      },
      {
        "id": "q13",
        "text": "Why is cleanliness part of the brand?",
        "type": "multiple_choice",
        "options": [
          "Because customers judge trust through what they can see.",
          "Because cleaning is only a closing task.",
          "Because it replaces product quality.",
          "Because it only matters during inspections."
        ],
        "correctAnswer": "Because customers judge trust through what they can see.",
        "explanation": "Visible cleanliness influences customer confidence.",
        "difficulty": "medium",
        "categoryTag": "Cleanliness"
      },
      {
        "id": "q14",
        "text": "A customer complains that their order is wrong. What should you say first?",
        "type": "multiple_choice",
        "options": [
          "\"That is what you ordered.\"",
          "\"Sorry about that. Let me check and fix it for you.\"",
          "\"We are too busy now.\"",
          "\"You should have checked earlier.\""
        ],
        "correctAnswer": "\"Sorry about that. Let me check and fix it for you.\"",
        "explanation": "Service recovery should be calm, polite and solution-focused.",
        "difficulty": "medium",
        "categoryTag": "Service Recovery"
      },
      {
        "id": "q15",
        "text": "Which sentence best describes the Milk Pop standard?",
        "type": "multiple_choice",
        "options": [
          "Make products quickly and move on.",
          "Keep the experience clean, simple, friendly, accurate and memorable.",
          "Focus only on upselling.",
          "Only worry about service when the manager is watching."
        ],
        "correctAnswer": "Keep the experience clean, simple, friendly, accurate and memorable.",
        "explanation": "Milk Pop’s standard combines speed, quality, cleanliness and care.",
        "difficulty": "medium",
        "categoryTag": "Standards"
      },
      {
        "id": "q16",
        "text": "Why does Milk Pop invest in staff training?",
        "type": "multiple_choice",
        "options": [
          "To make the role feel more complicated than it is.",
          "To support quality, safety, customer trust and staff growth.",
          "To replace the need for communication.",
          "To make exams difficult for no reason."
        ],
        "correctAnswer": "To support quality, safety, customer trust and staff growth.",
        "explanation": "Training protects the customer experience and helps staff become more confident and professional.",
        "difficulty": "medium",
        "categoryTag": "Training"
      },
      {
        "id": "q17",
        "text": "What is the best example of respect in a team environment?",
        "type": "multiple_choice",
        "options": [
          "Correcting a teammate harshly in front of customers.",
          "Ignoring issues to avoid uncomfortable conversations.",
          "Speaking clearly, helping when needed and raising issues professionally.",
          "Only supporting teammates you are close with."
        ],
        "correctAnswer": "Speaking clearly, helping when needed and raising issues professionally.",
        "explanation": "Respect means communicating professionally and supporting the team standard.",
        "difficulty": "medium",
        "categoryTag": "Team Culture"
      },
      {
        "id": "q18",
        "text": "A team member is clearly overwhelmed during a rush. What is the best response?",
        "type": "multiple_choice",
        "options": [
          "Ignore them because everyone has their own tasks.",
          "Criticise them after the rush in front of others.",
          "Offer practical help or inform the shift lead early.",
          "Take over everything without speaking."
        ],
        "correctAnswer": "Offer practical help or inform the shift lead early.",
        "explanation": "A strong team supports each other early and professionally.",
        "difficulty": "medium",
        "categoryTag": "Teamwork"
      },
      {
        "id": "q19",
        "text": "What does dedication mean at Milk Pop?",
        "type": "multiple_choice",
        "options": [
          "Working without breaks or support.",
          "Caring about the details consistently, even when the task seems simple.",
          "Only working hard when managers are present.",
          "Doing more than your role requires without communication."
        ],
        "correctAnswer": "Caring about the details consistently, even when the task seems simple.",
        "explanation": "Dedication is shown through consistent care, not dramatic gestures.",
        "difficulty": "medium",
        "categoryTag": "Dedication"
      },
      {
        "id": "q20",
        "text": "A customer seems nervous to ask a question. What should a confident team member do?",
        "type": "multiple_choice",
        "options": [
          "Wait until they speak first.",
          "Make them feel comfortable by offering help naturally.",
          "Tell them everything is written on the menu.",
          "Serve another customer immediately."
        ],
        "correctAnswer": "Make them feel comfortable by offering help naturally.",
        "explanation": "Good service reduces customer uncertainty and makes ordering easier.",
        "difficulty": "medium",
        "categoryTag": "Customer Service"
      },
      {
        "id": "q21",
        "text": "Which statement best reflects Milk Pop’s approach to staff growth?",
        "type": "multiple_choice",
        "options": [
          "Staff are expected to figure everything out alone.",
          "Milk Pop provides support and tools, while staff are expected to bring effort and commitment.",
          "Staff development is not important in a simple kiosk role.",
          "Only managers need to develop professional skills."
        ],
        "correctAnswer": "Milk Pop provides support and tools, while staff are expected to bring effort and commitment.",
        "explanation": "Milk Pop’s culture is built on support from the business and commitment from the team member.",
        "difficulty": "medium",
        "categoryTag": "Staff Growth"
      },
      {
        "id": "q22",
        "text": "Why should staff ask questions early?",
        "type": "multiple_choice",
        "options": [
          "Because it slows the shift down.",
          "Because asking early prevents mistakes and builds confidence.",
          "Because managers should make every decision.",
          "Because staff should avoid responsibility."
        ],
        "correctAnswer": "Because asking early prevents mistakes and builds confidence.",
        "explanation": "Asking early is responsible and prevents issues from becoming bigger.",
        "difficulty": "medium",
        "categoryTag": "Communication"
      },
      {
        "id": "q23",
        "text": "What is the risk of rushing without checking orders?",
        "type": "multiple_choice",
        "options": [
          "The queue always moves faster.",
          "Mistakes become more likely and customer trust can be damaged.",
          "Customers appreciate careless speed.",
          "It improves product consistency."
        ],
        "correctAnswer": "Mistakes become more likely and customer trust can be damaged.",
        "explanation": "Speed must be balanced with accuracy.",
        "difficulty": "medium",
        "categoryTag": "Accuracy"
      },
      {
        "id": "q24",
        "text": "Which action best shows communication during a shift?",
        "type": "multiple_choice",
        "options": [
          "Waiting until stock runs out before mentioning it.",
          "Quietly struggling without telling anyone.",
          "Letting the team know early that stock is low or help is needed.",
          "Only speaking during breaks."
        ],
        "correctAnswer": "Letting the team know early that stock is low or help is needed.",
        "explanation": "Good communication prevents avoidable problems.",
        "difficulty": "medium",
        "categoryTag": "Communication"
      },
      {
        "id": "q25",
        "text": "A customer leaves happy after a good experience. Why does this matter?",
        "type": "multiple_choice",
        "options": [
          "It only matters if they bought the most expensive item.",
          "Happy customers may return, recommend Milk Pop and support brand growth.",
          "It does not matter after the sale is complete.",
          "It only matters if they leave a review immediately."
        ],
        "correctAnswer": "Happy customers may return, recommend Milk Pop and support brand growth.",
        "explanation": "Repeat visits and recommendations are built through positive experiences.",
        "difficulty": "medium",
        "categoryTag": "Growth"
      },
      {
        "id": "q26",
        "text": "What should a staff member do after making a mistake?",
        "type": "multiple_choice",
        "options": [
          "Hide it if possible.",
          "Blame someone else.",
          "Stay calm, acknowledge it, correct it and learn from it.",
          "Stop serving customers."
        ],
        "correctAnswer": "Stay calm, acknowledge it, correct it and learn from it.",
        "explanation": "Professional recovery protects trust and supports learning.",
        "difficulty": "medium",
        "categoryTag": "Recovery"
      },
      {
        "id": "q27",
        "text": "Which statement best describes professional confidence?",
        "type": "multiple_choice",
        "options": [
          "Pretending to know everything.",
          "Speaking clearly, knowing when to check and staying calm.",
          "Never asking questions.",
          "Moving quickly without listening."
        ],
        "correctAnswer": "Speaking clearly, knowing when to check and staying calm.",
        "explanation": "Real confidence includes clarity, honesty and good judgement.",
        "difficulty": "medium",
        "categoryTag": "Confidence"
      },
      {
        "id": "q28",
        "text": "Why is the first impression important?",
        "type": "multiple_choice",
        "options": [
          "Customers decide quickly whether a place feels worth stopping for.",
          "It only matters for new customers.",
          "It matters less than the final handover.",
          "Staff cannot influence it."
        ],
        "correctAnswer": "Customers decide quickly whether a place feels worth stopping for.",
        "explanation": "Shopping centre customers often make fast decisions based on visible standards and staff behaviour.",
        "difficulty": "medium",
        "categoryTag": "First Impression"
      },
      {
        "id": "q29",
        "text": "Which response best shows Milk Pop’s customer tone?",
        "type": "multiple_choice",
        "options": [
          "\"It is on the menu.\"",
          "\"I do not know.\"",
          "\"Let me check that properly for you.\"",
          "\"Choose quickly, please.\""
        ],
        "correctAnswer": "\"Let me check that properly for you.\"",
        "explanation": "Milk Pop service should be helpful, clear and professional.",
        "difficulty": "medium",
        "categoryTag": "Tone"
      },
      {
        "id": "q30",
        "text": "What is the best reason to keep the work station organised?",
        "type": "multiple_choice",
        "options": [
          "It only looks better for managers.",
          "It helps speed, safety, cleanliness and confidence.",
          "It makes training unnecessary.",
          "It only matters during inspections."
        ],
        "correctAnswer": "It helps speed, safety, cleanliness and confidence.",
        "explanation": "Organisation supports safe and efficient service.",
        "difficulty": "medium",
        "categoryTag": "Organisation"
      },
      {
        "id": "q31",
        "text": "What should the customer feel when ordering from Milk Pop?",
        "type": "multiple_choice",
        "options": [
          "Confused but impressed.",
          "Rushed and pressured.",
          "Welcome, clear and confident in their choice.",
          "Ignored until they are ready."
        ],
        "correctAnswer": "Welcome, clear and confident in their choice.",
        "explanation": "Milk Pop should make ordering feel easy and comfortable.",
        "difficulty": "medium",
        "categoryTag": "Customer Experience"
      },
      {
        "id": "q32",
        "text": "What is the connection between staff improvement and business growth?",
        "type": "multiple_choice",
        "options": [
          "They are unrelated.",
          "Better staff habits improve customer experience, which supports repeat visits and growth.",
          "Business growth depends only on advertising.",
          "Staff improvement only matters for managers."
        ],
        "correctAnswer": "Better staff habits improve customer experience, which supports repeat visits and growth.",
        "explanation": "Daily staff behaviour directly shapes customer experience and long-term growth.",
        "difficulty": "medium",
        "categoryTag": "Growth"
      },
      {
        "id": "q33",
        "text": "A staff member receives feedback from a manager. What is the most professional response?",
        "type": "multiple_choice",
        "options": [
          "Take it personally and stop communicating.",
          "Listen, ask questions if needed and use it to improve.",
          "Ignore it if the shift was busy.",
          "Blame another team member."
        ],
        "correctAnswer": "Listen, ask questions if needed and use it to improve.",
        "explanation": "Feedback is part of professional growth.",
        "difficulty": "medium",
        "categoryTag": "Feedback"
      },
      {
        "id": "q34",
        "text": "Which statement best describes Milk Pop’s support system?",
        "type": "multiple_choice",
        "options": [
          "Staff are supported through training, tools, systems and clear standards.",
          "Staff should succeed without guidance.",
          "Support means standards should be low.",
          "Support is only needed during the first shift."
        ],
        "correctAnswer": "Staff are supported through training, tools, systems and clear standards.",
        "explanation": "Milk Pop aims to support staff properly while still expecting commitment.",
        "difficulty": "medium",
        "categoryTag": "Support System"
      },
      {
        "id": "q35",
        "text": "What is the strongest summary of Module 1?",
        "type": "multiple_choice",
        "options": [
          "Milk Pop is simple, so the role is easy.",
          "Milk Pop is simple for customers because the team is trained, supported, respectful and committed.",
          "Milk Pop only cares about speed.",
          "Milk Pop’s standards only matter during busy periods."
        ],
        "correctAnswer": "Milk Pop is simple for customers because the team is trained, supported, respectful and committed.",
        "explanation": "This is the central message of the module.",
        "difficulty": "medium",
        "categoryTag": "Summary"
      }
    ]
  }
];
