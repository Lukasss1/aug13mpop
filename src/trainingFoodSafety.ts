import { TrainingAssessment } from './types';

/**
 * FOOD HYGIENE, SAFETY & ALLERGEN CURRICULUM — four mandatory Academy modules.
 *
 * Figures follow UK Food Standards Agency guidance for England (where both
 * Milk Pop stores trade): chilled ≤ 8 °C by law (target ≤ 5 °C), frozen
 * −18 °C, hot holding ≥ 63 °C, cook to 75 °C core, the 8–63 °C danger zone,
 * the one-period 4-hour chilled display rule, the 48-hour return-to-work rule,
 * the 14 regulated allergens and Natasha's Law (PPDS labelling, Oct 2021).
 * If official guidance changes, update the slides AND the questions together.
 *
 * Question types used: multiple_choice, true_false and drag_drop (gap-fill —
 * every [[word]] in dragTemplate becomes a gap; dragDistractors are mixed
 * into the word bank).
 */
export const FOOD_SAFETY_MODULES: TrainingAssessment[] = [
  /* ======================================================================
     MODULE FS1 — FOOD HYGIENE ESSENTIALS (LEVEL 1)
     ====================================================================== */
  {
    id: 'fs1',
    title: 'Food Hygiene Essentials (Level 1)',
    description:
      'The personal hygiene foundation every Milk Pop team member must master before handling any food: handwashing, uniform standards, fitness to work and the habits that keep bacteria out of our shakes.',
    learningObjectives: [
      'Why food handlers carry legal hygiene responsibilities',
      'When and how to wash hands (the 20-second standard)',
      'Uniform, jewellery, nails and hair rules',
      'Cuts, wounds and blue detectable plasters',
      'The 48-hour rule after sickness or diarrhoea',
      'Reporting illness before a shift',
    ],
    passingScore: 85,
    category: 'safety',
    points: 400,
    badge: 'Hygiene Foundation',
    dueDays: 7,
    mandatory: true,
    slides: [
      {
        title: 'Why hygiene is a legal duty, not a preference',
        content:
          'Everyone who handles food at Milk Pop is a "food handler" in law. Under UK food hygiene regulations you must protect food from contamination — and your personal hygiene is the first control.\n\nBacteria you cannot see or smell live on skin, in hair, in the nose and gut, and under nails. A single lapse — an unwashed hand after the toilet, a cough over an open milk jug — can transfer enough bacteria to make a customer seriously ill.\n\nOur promise is "premium-cute" — but behind the counter it is built on strict, professional hygiene. Customers should never have to think about it, because we always do.',
      },
      {
        title: 'Handwashing: the single most important control',
        content:
          'Wash hands with warm running water and liquid soap for at least 20 seconds — lather palms, backs, between fingers, thumbs, fingertips and wrists — then rinse and dry with paper towel (a damp hand transfers bacteria far more easily than a dry one).\n\nALWAYS wash hands:\n• Before starting work and after every break\n• After using the toilet — every time, no exceptions\n• After touching your face, hair, nose or phone\n• After handling waste, cleaning chemicals or money\n• After handling raw ingredients or allergen toppings (e.g. nuts)\n• After coughing, sneezing or blowing your nose\n\nHand gel is a top-up, never a substitute for washing.',
      },
      {
        title: 'Uniform, jewellery, nails and hair',
        content:
          'Arrive in a clean uniform every shift and put your apron on at work, not at home. Aprons come off before toilet breaks and before taking out waste.\n\n• Jewellery: a plain wedding band only. Stones, watches and bracelets trap bacteria and can fall into food (a physical contamination hazard).\n• Nails: short, clean, no varnish or false nails — flakes and gems end up in shakes.\n• Hair: tied back and secured under your cap. Beards over stubble length need a beard cover in prep areas.\n• Phones stay off the counter — they carry more bacteria than a toilet seat.',
      },
      {
        title: 'Cuts, wounds and blue plasters',
        content:
          'Any cut, burn, spot or wound on hands or arms must be fully covered with a BLUE detectable plaster from the first-aid kit — blue because no food is naturally blue, so a lost plaster is spotted instantly; detectable because the metal strip shows up if one is ever lost into product.\n\nCheck your plaster is still in place after washing hands. If a plaster is lost while preparing food, STOP, tell the shift supervisor immediately, and the affected open food is discarded. Never be embarrassed to report it — the only mistake is staying silent.',
      },
      {
        title: 'Fitness to work and the 48-hour rule',
        content:
          'You must NOT work with open food if you have:\n• Vomiting or diarrhoea — stay away until 48 HOURS after the last symptom, even if you feel fine sooner. You can still shed bacteria after symptoms stop.\n• Infected cuts or skin conditions on hands/arms that cannot be fully covered\n• Discharge from eyes, ears or nose beyond a mild cold\n\nCall your manager BEFORE your shift starts — never just push through. A manager can never penalise you for honest illness reporting; hiding it is what puts customers, the team and the business at risk.',
      },
    ],
    questions: [
      {
        id: 'fs1q1',
        text: 'You have just used the toilet on your break. The queue is huge and your supervisor calls you straight to the blender station. What must you do first?',
        type: 'multiple_choice',
        options: [
          'Go straight to the station — the queue comes first.',
          'Rub hand gel in while walking to the station.',
          'Wash hands for at least 20 seconds with soap and warm water, dry with paper towel, then go.',
          'Wipe hands on your apron and start blending.',
        ],
        correctAnswer: 'Wash hands for at least 20 seconds with soap and warm water, dry with paper towel, then go.',
        explanation: 'Handwashing after the toilet is non-negotiable. Gel is a top-up, never a substitute, and queues never override the hygiene standard.',
        difficulty: 'easy',
        categoryTag: 'Handwashing',
      },
      {
        id: 'fs1q2',
        text: 'Complete the handwashing and plaster standard.',
        type: 'drag_drop',
        options: [],
        correctAnswer: '',
        dragTemplate:
          'Wash hands for at least [[20]] seconds with warm water and [[soap]], then dry with [[paper towel]]. Any cut on your hands must be covered with a [[blue]] detectable plaster.',
        dragDistractors: ['5', '60', 'gel', 'cloth', 'clear', 'beige'],
        explanation: '20 seconds with soap, dried on paper towel; cuts are covered with blue detectable plasters so a lost one is spotted immediately.',
        difficulty: 'medium',
        categoryTag: 'Handwashing',
      },
      {
        id: 'fs1q3',
        text: 'You had diarrhoea on Monday evening. Your symptoms stopped completely on Tuesday at 8pm. When is the earliest you may return to handling food?',
        type: 'multiple_choice',
        options: [
          'Wednesday morning, as long as you feel fine.',
          'Tuesday night — as soon as symptoms stop.',
          'Thursday at 8pm — 48 hours after the last symptom.',
          'Friday, to be extra careful.',
        ],
        correctAnswer: 'Thursday at 8pm — 48 hours after the last symptom.',
        explanation: 'The 48-hour rule runs from the LAST symptom, because you can shed harmful bacteria after you feel better.',
        difficulty: 'medium',
        categoryTag: 'Fitness to Work',
      },
      {
        id: 'fs1q4',
        text: 'Hand gel is an acceptable replacement for handwashing when the store is very busy.',
        type: 'true_false',
        options: ['True', 'False'],
        correctAnswer: 'False',
        explanation: 'Gel does not remove physical soiling and misses many organisms. It only ever tops up a proper 20-second wash.',
        difficulty: 'easy',
        categoryTag: 'Handwashing',
      },
      {
        id: 'fs1q5',
        text: 'Which of these is allowed while preparing shakes at Milk Pop?',
        type: 'multiple_choice',
        options: [
          'A charm bracelet, as long as it is clean.',
          'A plain wedding band.',
          'Clear nail varnish only.',
          'A smartwatch for checking order times.',
        ],
        correctAnswer: 'A plain wedding band.',
        explanation: 'Only a plain band is permitted. Stones, straps, watches and any varnish are contamination hazards.',
        difficulty: 'easy',
        categoryTag: 'Uniform Standards',
      },
      {
        id: 'fs1q6',
        text: 'You notice your blue plaster is missing after making three milkshakes. What is the correct response?',
        type: 'multiple_choice',
        options: [
          'Quietly put on a new plaster and carry on — it is probably in the bin.',
          'Stop, tell the shift supervisor immediately, and discard the affected open food.',
          'Check the last shake you made and only act if you can see it.',
          'Finish the queue first, then look for it.',
        ],
        correctAnswer: 'Stop, tell the shift supervisor immediately, and discard the affected open food.',
        explanation: 'A lost plaster is a physical contamination incident. Stop, report, discard. Honesty protects customers; silence is the only real mistake.',
        difficulty: 'medium',
        categoryTag: 'Contamination',
      },
      {
        id: 'fs1q7',
        text: 'Fill the gaps in the fitness-to-work rule.',
        type: 'drag_drop',
        options: [],
        correctAnswer: '',
        dragTemplate:
          'After vomiting or diarrhoea you must stay away from food handling until [[48]] hours after your [[last]] symptom, and you must tell your manager [[before]] your shift starts.',
        dragDistractors: ['24', '72', 'first', 'after', 'during'],
        explanation: '48 hours from the LAST symptom, and the call happens before the shift — never mid-shift or after.',
        difficulty: 'medium',
        categoryTag: 'Fitness to Work',
      },
      {
        id: 'fs1q8',
        text: 'Why are plasters used in food businesses blue?',
        type: 'multiple_choice',
        options: [
          'Blue matches the Milk Pop brand palette.',
          'Blue plasters are more waterproof than beige ones.',
          'No food is naturally blue, so a lost plaster is spotted immediately.',
          'It is a customer-facing style choice.',
        ],
        correctAnswer: 'No food is naturally blue, so a lost plaster is spotted immediately.',
        explanation: 'Visibility is the point — plus the metal detectable strip in professional kitchens.',
        difficulty: 'easy',
        categoryTag: 'Contamination',
      },
    ],
  },

  /* ======================================================================
     MODULE FS2 — TEMPERATURE & STORAGE CONTROL
     ====================================================================== */
  {
    id: 'fs2',
    title: 'Food Safety: Temperature & Storage Control',
    description:
      'Milk is a high-risk food and it is our core ingredient. Master the danger zone, legal fridge and freezer temperatures, date labels, FIFO rotation and delivery checks that keep every Milk Pop shake safe.',
    learningObjectives: [
      'The 8–63 °C danger zone and why milk is high-risk',
      'Legal chilled storage (≤ 8 °C) and our ≤ 5 °C target',
      'Frozen storage at −18 °C',
      'Use-by vs best-before dates',
      'FIFO stock rotation and labelling opened product',
      'The one-period 4-hour chilled display rule',
      'Checking and recording deliveries and fridge temps',
    ],
    passingScore: 85,
    category: 'safety',
    points: 450,
    badge: 'Temperature Controller',
    dueDays: 7,
    mandatory: true,
    slides: [
      {
        title: 'The danger zone: 8 °C to 63 °C',
        content:
          'Harmful bacteria multiply fastest between 8 °C and 63 °C — the DANGER ZONE. In ideal warmth (around body temperature) some bacteria double every 10–20 minutes: one cell can become millions within a shift.\n\nEverything we do with temperature has one goal: keep high-risk food OUT of the danger zone, or through it as quickly as possible.\n\nMilk, cream, ice cream mix and dairy toppings are high-risk foods — ready to consume, moist and protein-rich, exactly what bacteria love. At Milk Pop, temperature control is not a back-office task; it is the product.',
      },
      {
        title: 'Chilled: 8 °C is the law, 5 °C is our standard',
        content:
          'In England the law requires high-risk chilled food to be kept at 8 °C or below. Milk Pop sets the fridges to run at 5 °C or below — the safety margin means a door left open during a rush does not immediately become a legal breach.\n\n• Record fridge temperatures on the checklist at opening and closing.\n• If a fridge reads above 8 °C: tell the supervisor, check the door/seals, and do not use the milk until a manager has assessed how long it was warm.\n• Decant only what you need to the counter; the jug on the bench warms fast.',
      },
      {
        title: 'Frozen at −18 °C — and never refreeze',
        content:
          'Freezers run at −18 °C or colder. Freezing stops bacteria multiplying but does NOT kill them — the moment ice cream mix or frozen fruit thaws, surviving bacteria wake up and the danger-zone clock starts.\n\n• Never refreeze anything that has thawed.\n• Thaw only in the fridge, never on the counter.\n• A soft, sunken tub or frost inside packaging means a temperature abuse — report it, don\'t scoop it.',
      },
      {
        title: 'Use-by vs best-before, FIFO and open-date labels',
        content:
          'USE-BY is about SAFETY: after this date the food may be dangerous even if it looks and smells fine. It is illegal to sell or use food past its use-by date. Milk carries a use-by date — treat it as absolute.\n\nBEST-BEFORE is about QUALITY: a biscuit topping past best-before is stale, not dangerous.\n\nFIFO — First In, First Out: new stock goes BEHIND old stock, so the oldest date is always used first.\n\nWhen you open milk or cream, write the opening date/time on the label. Opened milk is used within the site rule (48 hours) or discarded — whichever comes before the printed use-by.',
      },
      {
        title: 'The 4-hour display rule and deliveries',
        content:
          'Chilled display (e.g. grab-and-go cakes): food may sit above 8 °C for ONE period of up to 4 HOURS. After that single period it must be thrown away — it can never go back in the fridge for tomorrow. Mark the out-of-fridge time on the tag.\n\nDeliveries: check chilled goods arrive at 8 °C or below (probe between packs), frozen goods arrive frozen solid, packaging is intact and dates are workable. Refuse and record anything that fails — a warm delivery accepted is OUR problem the moment we sign for it. Put chilled and frozen stock away FIRST, before dry goods.',
      },
    ],
    questions: [
      {
        id: 'fs2q1',
        text: 'Place the correct temperatures into the storage standard.',
        type: 'drag_drop',
        options: [],
        correctAnswer: '',
        dragTemplate:
          'By law, chilled high-risk food must be kept at [[8]] °C or below — Milk Pop fridges target [[5]] °C. Freezers run at [[-18]] °C, and hot food is held at [[63]] °C or above.',
        dragDistractors: ['10', '0', '-12', '75', '37'],
        explanation: '8 °C legal maximum, 5 °C site target, −18 °C frozen, 63 °C hot holding. These four numbers frame the danger zone.',
        difficulty: 'medium',
        categoryTag: 'Temperatures',
      },
      {
        id: 'fs2q2',
        text: 'The opening checklist shows the milk fridge at 10 °C. What is the correct action?',
        type: 'multiple_choice',
        options: [
          'Use the milk quickly before it gets warmer.',
          'Turn the dial down and carry on — it will cool soon.',
          'Tell the supervisor, do not use the milk, and wait for a manager to assess how long it has been above 8 °C.',
          'Move the milk to the freezer to bring it down fast.',
        ],
        correctAnswer: 'Tell the supervisor, do not use the milk, and wait for a manager to assess how long it has been above 8 °C.',
        explanation: 'Above the 8 °C legal limit the milk is quarantined until someone senior assesses the time/temperature history. Never "use it up quickly".',
        difficulty: 'medium',
        categoryTag: 'Chilled Storage',
      },
      {
        id: 'fs2q3',
        text: 'Freezing food at −18 °C kills the bacteria in it.',
        type: 'true_false',
        options: ['True', 'False'],
        correctAnswer: 'False',
        explanation: 'Freezing only pauses bacteria. They survive and multiply again on thawing — which is why thawed food is never refrozen.',
        difficulty: 'easy',
        categoryTag: 'Frozen Storage',
      },
      {
        id: 'fs2q4',
        text: 'A carton of milk smells and looks completely fine but is one day past its use-by date. What do you do?',
        type: 'multiple_choice',
        options: [
          'Use it — the smell test is reliable for milk.',
          'Use it only for hot drinks where it gets heated.',
          'Discard it. Using or selling food past its use-by date is unsafe and illegal.',
          'Ask a supervisor to smell it and decide.',
        ],
        correctAnswer: 'Discard it. Using or selling food past its use-by date is unsafe and illegal.',
        explanation: 'Use-by is a safety date. Pathogens like Listeria produce no smell or taste. Past use-by, the bin is the only option.',
        difficulty: 'easy',
        categoryTag: 'Date Labels',
      },
      {
        id: 'fs2q5',
        text: 'Complete the stock-rotation and display rules.',
        type: 'drag_drop',
        options: [],
        correctAnswer: '',
        dragTemplate:
          'FIFO means First In, First [[Out]] — new stock goes [[behind]] old stock. Chilled food on display may spend one period of up to [[4]] hours above 8 °C, after which it must be [[thrown away]].',
        dragDistractors: ['Off', 'in front of', '2', '8', 'refrigerated', 'refrozen'],
        explanation: 'Oldest stock is used first, and the 4-hour display allowance is single-use — the food never returns to the fridge afterwards.',
        difficulty: 'hard',
        categoryTag: 'Stock Rotation',
      },
      {
        id: 'fs2q6',
        text: 'A chilled delivery arrives and the milk probes at 12 °C between packs. The driver is in a hurry. What is the professional response?',
        type: 'multiple_choice',
        options: [
          'Accept it and put it in the fridge immediately to cool down.',
          'Refuse the chilled items, record the temperature and reason, and inform the manager.',
          'Accept it but write 8 °C on the sheet so the paperwork is clean.',
          'Accept it and use that milk first today.',
        ],
        correctAnswer: 'Refuse the chilled items, record the temperature and reason, and inform the manager.',
        explanation: 'Once signed for, an unsafe delivery becomes our unsafe stock. Refusal with a written record protects customers and the business — and falsifying records is gross misconduct.',
        difficulty: 'hard',
        categoryTag: 'Deliveries',
      },
      {
        id: 'fs2q7',
        text: 'Why is milk classed as a high-risk food?',
        type: 'multiple_choice',
        options: [
          'Because it is expensive to replace.',
          'Because it is ready to consume, moist and protein-rich — ideal conditions for bacterial growth.',
          'Because it contains lactose, which is an allergen.',
          'Because it must be imported daily.',
        ],
        correctAnswer: 'Because it is ready to consume, moist and protein-rich — ideal conditions for bacterial growth.',
        explanation: 'High-risk foods need no further cooking and readily support bacterial growth — exactly the profile of milk, cream and ice cream mix.',
        difficulty: 'medium',
        categoryTag: 'High-Risk Foods',
      },
      {
        id: 'fs2q8',
        text: 'When you open a fresh carton of milk you should write the opening date and time on it.',
        type: 'true_false',
        options: ['True', 'False'],
        correctAnswer: 'True',
        explanation: 'Open-date labelling drives the 48-hour opened-milk rule and lets anyone on any shift know exactly how old the product is.',
        difficulty: 'easy',
        categoryTag: 'Labelling',
      },
    ],
  },

  /* ======================================================================
     MODULE FS3 — ALLERGEN AWARENESS & NATASHA'S LAW
     ====================================================================== */
  {
    id: 'fs3',
    title: 'Allergen Awareness & Natasha\u2019s Law',
    description:
      'An allergic reaction can kill in minutes, and milkshake counters combine the two most dangerous allergens: milk everywhere and nuts in toppings. Learn the 14 regulated allergens, Natasha\u2019s Law, cross-contact control and exactly what to say and do when an allergic customer orders.',
    learningObjectives: [
      'The 14 UK regulated allergens',
      'Allergy vs intolerance — why "a little bit" can kill',
      'Natasha\u2019s Law and PPDS labelling',
      'Using the allergen matrix — never guessing',
      'Preventing cross-contact at a milkshake counter',
      'Responding to a suspected anaphylactic reaction',
    ],
    passingScore: 85,
    category: 'safety',
    points: 500,
    badge: 'Allergy Guardian',
    dueDays: 5,
    mandatory: true,
    slides: [
      {
        title: 'Why this module can save a life',
        content:
          'For an allergic customer, food safety is not about hygiene percentages — a trace of the wrong ingredient can trigger anaphylaxis: airway swelling, collapse and, without fast treatment, death. Reactions can begin within minutes.\n\nNatasha Ednan-Laperouse died in 2016 after eating a baguette with sesame baked in but not labelled. The law that followed carries her name, and it exists so that no customer ever has to gamble on what is in their food.\n\nAt a milkshake bar the stakes are concentrated: MILK is in almost everything we sell, and NUT toppings sit centimetres from shared equipment. This module is mandatory for every role.',
      },
      {
        title: 'The 14 regulated allergens',
        content:
          'UK law regulates 14 allergens. Learn them — customers will ask about all of them:\n\n1. Celery\n2. Cereals containing gluten (wheat, rye, barley, oats)\n3. Crustaceans (e.g. prawns)\n4. Eggs\n5. Fish\n6. Lupin\n7. MILK — our biggest one\n8. Molluscs (e.g. mussels)\n9. Mustard\n10. Peanuts\n11. Sesame\n12. Soya\n13. Sulphur dioxide / sulphites (above 10 mg/kg or 10 mg/L)\n14. Tree nuts (almonds, hazelnuts, walnuts, cashews, pecans, pistachios, brazil, macadamia)\n\nNote: peanuts and tree nuts are SEPARATE allergens — "nut-free" claims must consider both.',
      },
      {
        title: 'Natasha\u2019s Law and how customers get allergen information',
        content:
          'Since 1 October 2021, any food PREPACKED FOR DIRECT SALE (PPDS) — made and packed on our premises before the customer orders it, like a wrapped cake slice in the display fridge — must carry a full ingredients list with the 14 allergens EMPHASISED (e.g. bold).\n\nFood made to order (a shake blended in front of the customer) does not need a printed label, but we MUST provide accurate allergen information — ours lives in the ALLERGEN MATRIX at the till and in the staff portal.\n\nThe golden rule: NEVER answer an allergen question from memory. Check the matrix every time — recipes and supplier ingredients change. If the matrix cannot answer it, a manager checks the actual packaging. "I don\'t know, let me check" is professional; guessing is dangerous.',
      },
      {
        title: 'Cross-contact: the invisible transfer',
        content:
          'Cross-contact is when an allergen transfers via equipment, hands or splashes — invisible amounts can be enough to trigger a reaction.\n\nHigh-risk points at Milk Pop:\n• Blender jugs and spindles — a "dairy-free" shake made in an unwashed jug is NOT dairy-free. Use the designated jug and wash-rinse-sanitise between allergen-relevant orders.\n• Scoops and spoons — one scoop per topping tub, always returned to its own tub. Never dig the nut scoop into the fudge.\n• Nut toppings — stored and handled away from open product; wash hands after touching.\n• Cloths and surfaces — a wipe with a nutty cloth spreads the allergen everywhere.\n\nFor an allergen-flagged order: wash hands, use freshly cleaned equipment, keep the order away from topping stations, and tell the customer honestly that we handle nuts and milk on site so we cannot guarantee a totally allergen-free environment.',
      },
      {
        title: 'When a customer declares an allergy — and when things go wrong',
        content:
          'When a customer mentions ANY allergy:\n1. Take it seriously — never eye-roll a "mild" allergy; severity can change between exposures.\n2. Check the matrix together for their allergen.\n3. Flag the order so the maker knows: clean equipment, fresh hands.\n4. Be honest about cross-contact risk — the customer decides with full information.\n\nIf a customer shows signs of a serious reaction (lip/face swelling, difficulty breathing, widespread rash, collapse):\n• Call 999 IMMEDIATELY and say "suspected anaphylaxis".\n• If they carry an adrenaline auto-injector (EpiPen), help them use it without delay — used promptly it saves lives.\n• Do not move them to "get some air"; keep them still, lying down with legs raised unless breathing is difficult (then sitting up).\n• Send a colleague to meet the ambulance. Keep the packaging/order details for the paramedics.',
      },
    ],
    questions: [
      {
        id: 'fs3q1',
        text: 'A customer asks whether the Salted Caramel shake contains sesame. You are almost certain it does not. What is the correct response?',
        type: 'multiple_choice',
        options: [
          'Say "no" confidently — hesitation worries customers.',
          'Say it is probably fine but they order at their own risk.',
          'Check the allergen matrix (or have a manager check the packaging) before answering, every single time.',
          'Suggest a different drink to avoid the question.',
        ],
        correctAnswer: 'Check the allergen matrix (or have a manager check the packaging) before answering, every single time.',
        explanation: 'Allergen answers never come from memory. Recipes and supplier ingredients change; the matrix is the single source of truth.',
        difficulty: 'easy',
        categoryTag: 'Allergen Information',
      },
      {
        id: 'fs3q2',
        text: 'Complete the key facts about allergen law.',
        type: 'drag_drop',
        options: [],
        correctAnswer: '',
        dragTemplate:
          'UK law regulates [[14]] allergens. Under Natasha\u2019s Law, food prepacked for [[direct sale]] must list every ingredient with allergens [[emphasised]]. Sulphites count above [[10]] mg per kg or litre.',
        dragDistractors: ['12', '8', 'delivery', 'wholesale', 'hidden', '100', '50'],
        explanation: '14 allergens; PPDS food needs a full, allergen-emphasised ingredient list; the sulphite threshold is 10 mg/kg or 10 mg/L.',
        difficulty: 'hard',
        categoryTag: 'Natasha\u2019s Law',
      },
      {
        id: 'fs3q3',
        text: 'Peanuts and tree nuts (like almonds and hazelnuts) count as the same allergen under UK rules.',
        type: 'true_false',
        options: ['True', 'False'],
        correctAnswer: 'False',
        explanation: 'They are two separate regulated allergens — peanuts are legumes. A customer can be allergic to one and not the other, so both are always checked.',
        difficulty: 'medium',
        categoryTag: '14 Allergens',
      },
      {
        id: 'fs3q4',
        text: 'A customer with a dairy allergy orders an oat-milk shake. The last shake made in that blender jug was a regular milk one and the jug has only been rinsed with water. What do you do?',
        type: 'multiple_choice',
        options: [
          'Use the jug — rinsing removes almost all the milk.',
          'Use the designated jug (or a fully washed, rinsed and sanitised one), wash your hands, and flag the order as allergen-critical.',
          'Make the shake but mention it might have a tiny bit of milk.',
          'Refuse the order — dairy-allergic customers cannot be served here.',
        ],
        correctAnswer: 'Use the designated jug (or a fully washed, rinsed and sanitised one), wash your hands, and flag the order as allergen-critical.',
        explanation: 'A water rinse does not remove allergen residue. Clean equipment + clean hands + a flagged order is the cross-contact control, alongside an honest note about the shared environment.',
        difficulty: 'medium',
        categoryTag: 'Cross-Contact',
      },
      {
        id: 'fs3q5',
        text: 'Which of these is a tree nut rather than a legume or seed?',
        type: 'multiple_choice',
        options: ['Peanut', 'Sesame', 'Hazelnut', 'Soya bean'],
        correctAnswer: 'Hazelnut',
        explanation: 'Hazelnuts, almonds, walnuts, cashews, pecans, pistachios, brazils and macadamias are tree nuts. Peanuts are legumes; sesame and soya are their own categories.',
        difficulty: 'easy',
        categoryTag: '14 Allergens',
      },
      {
        id: 'fs3q6',
        text: 'A customer\u2019s lips and face begin to swell moments after their first sip and they are struggling to breathe. Put the priorities in place.',
        type: 'drag_drop',
        options: [],
        correctAnswer: '',
        dragTemplate:
          'Call [[999]] immediately and say suspected [[anaphylaxis]]. If they carry an adrenaline [[auto-injector]], help them use it without delay, and keep them [[still]] while a colleague meets the ambulance.',
        dragDistractors: ['111', 'indigestion', 'inhaler', 'antihistamine', 'walking'],
        explanation: '999 + "anaphylaxis" + prompt adrenaline + keeping the casualty still. Minutes matter; an inhaler or antihistamine does not treat anaphylaxis.',
        difficulty: 'hard',
        categoryTag: 'Emergency Response',
      },
      {
        id: 'fs3q7',
        text: 'Why does one scoop live in one topping tub and never travel?',
        type: 'multiple_choice',
        options: [
          'It keeps stock counting accurate.',
          'It prevents invisible allergen cross-contact between toppings, e.g. nut traces landing in the fudge tub.',
          'It looks tidier for customers.',
          'It slows down over-portioning.',
        ],
        correctAnswer: 'It prevents invisible allergen cross-contact between toppings, e.g. nut traces landing in the fudge tub.',
        explanation: 'A travelling scoop turns every tub it touches into a nut-containing tub. Trace amounts are enough to cause a reaction.',
        difficulty: 'medium',
        categoryTag: 'Cross-Contact',
      },
      {
        id: 'fs3q8',
        text: 'A shake blended to order in front of the customer legally requires a printed ingredient label under Natasha\u2019s Law.',
        type: 'true_false',
        options: ['True', 'False'],
        correctAnswer: 'False',
        explanation: 'PPDS labelling applies to food packed BEFORE the customer orders it (like a wrapped cake slice). Made-to-order food needs accurate allergen information available — our matrix — not a printed label.',
        difficulty: 'hard',
        categoryTag: 'Natasha\u2019s Law',
      },
    ],
  },

  /* ======================================================================
     MODULE FS4 — CLEANING, CROSS-CONTAMINATION & WASTE
     ====================================================================== */
  {
    id: 'fs4',
    title: 'Cleaning, Cross-Contamination & Waste Control',
    description:
      'Clean-as-you-go, the two-stage clean, sanitiser contact time, colour-coded cloths, blender strip-downs, chemical safety, pest awareness and waste handling — the systems that keep the whole counter safe, not just one order.',
    learningObjectives: [
      'Cleaning vs disinfecting: the two-stage clean',
      'Sanitiser contact time and food-safe chemicals (BS EN 1276/13697)',
      'Colour-coded cloths and clean-as-you-go',
      'Daily blender and machine strip-down',
      'Chemical contamination and safe storage',
      'Pest awareness and reporting',
      'Waste handling without contaminating food areas',
    ],
    passingScore: 80,
    category: 'safety',
    points: 450,
    badge: 'Clean Counter Certified',
    dueDays: 10,
    mandatory: true,
    slides: [
      {
        title: 'Cleaning and disinfecting are two different jobs',
        content:
          'CLEANING with detergent removes visible dirt, grease and food debris. DISINFECTING with a sanitiser kills the bacteria you cannot see. A shiny surface can still be crawling with bacteria — which is why food-contact surfaces get the TWO-STAGE CLEAN:\n\n1. Clean: remove debris with detergent and rinse.\n2. Disinfect: apply food-safe sanitiser and leave it WET for the CONTACT TIME on the label (typically 30–60 seconds for our spray) before wiping.\n\nSpraying and instantly wiping achieves stage 1 only. Our sanitiser meets BS EN 1276/13697 — the standard that proves it actually kills food-poisoning bacteria.',
      },
      {
        title: 'Clean-as-you-go and colour-coded cloths',
        content:
          'Mess is never "for later". Spilled milk on a warm counter is a bacterial breeding ground within minutes — wipe, wash and sanitise as part of making each order, not as a closing chore.\n\nCloths carry bacteria brilliantly, so they are colour-coded and never cross over:\n• BLUE — food-contact surfaces and prep areas\n• RED — toilets and washroom areas (these never enter the prep area)\n• GREEN — front-of-house tables and customer areas\n\nCloths go to the wash (or the bin, for disposables) at least every shift — a dirty cloth spreads more bacteria than it removes.',
      },
      {
        title: 'Machines: the daily strip-down',
        content:
          'Blenders, spindles, soft-serve machines and milk lines are where residue hides. Milk residue in a warm machine is the single biggest bacterial risk in a shake bar.\n\n• Blender jugs, lids and spindles: washed, rinsed and sanitised through the day and fully stripped at close.\n• Soft-serve machine: follow the manufacturer strip-down and sanitise schedule exactly — never skip steps on a busy night.\n• Drip trays, nozzles and seals: removed and cleaned, not just wiped around.\n\nIf you are not trained on a machine\u2019s strip-down, say so — a wrong reassembly is both a hygiene and a safety hazard.',
      },
      {
        title: 'Chemicals: the contamination you pour',
        content:
          'Cleaning chemicals protect food only when they never touch it:\n• Store chemicals in their original labelled containers, in the chemical cupboard, always BELOW and AWAY from food — never on a shelf above open product.\n• NEVER decant chemicals into drink cups or food containers. People have been seriously injured drinking sanitiser from an unlabelled cup.\n• Use the right dilution — double-strength is not double-clean, it is a chemical residue risk.\n• Never mix chemicals (bleach + acid descaler releases toxic gas).\n• Wash hands after handling chemicals and before touching food.',
      },
      {
        title: 'Pests and waste',
        content:
          'Pests (mice, rats, flies, cockroaches) carry disease and are attracted by exactly what we have: sugar, dairy and warmth.\n\n• Report ANY sign immediately: droppings, gnawed packaging, grease smears, dead insects. Reporting a sighting is praised, never punished.\n• Keep external doors closed, keep deliveries off the floor, keep dry stock sealed and on shelves.\n\nWaste:\n• Food waste goes in lidded bins, emptied before they overflow and always at closing.\n• Take your apron off before taking rubbish out; wash hands when you come back in — every time.\n• Bin areas stay clean and lids stay closed: an open, overflowing bin is a pest invitation to the whole shopping centre.',
      },
    ],
    questions: [
      {
        id: 'fs4q1',
        text: 'Complete the two-stage clean.',
        type: 'drag_drop',
        options: [],
        correctAnswer: '',
        dragTemplate:
          'Stage one: clean with [[detergent]] to remove dirt and grease. Stage two: apply food-safe [[sanitiser]] and leave it wet for the full [[contact time]] before wiping.',
        dragDistractors: ['bleach', 'water', 'polish', 'a few seconds'],
        explanation: 'Detergent removes soil; sanitiser kills bacteria — but only if it stays wet for the labelled contact time.',
        difficulty: 'medium',
        categoryTag: 'Two-Stage Clean',
      },
      {
        id: 'fs4q2',
        text: 'You spray sanitiser on the prep counter and immediately wipe it dry to serve the next customer faster. What has actually happened?',
        type: 'multiple_choice',
        options: [
          'The counter is fully disinfected — the spray works on contact.',
          'The counter is clean but NOT disinfected, because the sanitiser needs its full contact time to kill bacteria.',
          'The counter is now more dangerous than before.',
          'Nothing — sanitiser is only for closing time.',
        ],
        correctAnswer: 'The counter is clean but NOT disinfected, because the sanitiser needs its full contact time to kill bacteria.',
        explanation: 'Contact time is the kill step. Spray-and-instant-wipe looks diligent but leaves the bacteria behind.',
        difficulty: 'medium',
        categoryTag: 'Two-Stage Clean',
      },
      {
        id: 'fs4q3',
        text: 'Which cloth may be used on the milkshake prep counter?',
        type: 'multiple_choice',
        options: [
          'The red cloth, once it has been rinsed well.',
          'Any cloth that looks clean.',
          'The blue food-contact cloth only.',
          'The green front-of-house cloth if the blue one is in the wash.',
        ],
        correctAnswer: 'The blue food-contact cloth only.',
        explanation: 'Colour coding only works when it is absolute. Red cloths (washrooms) never enter prep, and "looks clean" is not a hygiene standard.',
        difficulty: 'easy',
        categoryTag: 'Colour Coding',
      },
      {
        id: 'fs4q4',
        text: 'It is acceptable to decant sanitiser into a spare milkshake cup for a quick job, as long as you use it straight away.',
        type: 'true_false',
        options: ['True', 'False'],
        correctAnswer: 'False',
        explanation: 'Chemicals never go into food or drink containers under any circumstances — unlabelled decanting has caused real chemical-poisoning injuries.',
        difficulty: 'easy',
        categoryTag: 'Chemical Safety',
      },
      {
        id: 'fs4q5',
        text: 'You spot what look like mouse droppings behind the dry-stock shelf near closing time. What is the correct action?',
        type: 'multiple_choice',
        options: [
          'Sweep them up and mention it if you see more.',
          'Report it to the manager immediately, leave the evidence in place, and the affected area/stock is checked before use.',
          'Put down some traps from the cupboard and monitor it yourself.',
          'Ignore it — it is a shopping-centre problem, not ours.',
        ],
        correctAnswer: 'Report it to the manager immediately, leave the evidence in place, and the affected area/stock is checked before use.',
        explanation: 'Pest signs trigger immediate reporting and professional response. Evidence in place helps the pest controller; sweeping it away hides the problem.',
        difficulty: 'medium',
        categoryTag: 'Pest Control',
      },
      {
        id: 'fs4q6',
        text: 'Why is milk residue inside a warm blender spindle considered the biggest bacterial risk at a shake bar?',
        type: 'multiple_choice',
        options: [
          'It makes the next shake taste slightly off.',
          'It is a high-risk food sitting in the danger zone, feeding bacterial growth that then touches every following order.',
          'It damages the motor over time.',
          'It attracts customers\u2019 attention.',
        ],
        correctAnswer: 'It is a high-risk food sitting in the danger zone, feeding bacterial growth that then touches every following order.',
        explanation: 'Warm dairy residue combines a high-risk food, danger-zone temperature and repeated contact with new product — the perfect contamination chain.',
        difficulty: 'medium',
        categoryTag: 'Equipment Cleaning',
      },
      {
        id: 'fs4q7',
        text: 'Complete the waste and chemical storage rules.',
        type: 'drag_drop',
        options: [],
        correctAnswer: '',
        dragTemplate:
          'Take your [[apron]] off before taking rubbish out and [[wash hands]] when you return. Chemicals are stored in their [[original]] labelled containers, kept [[away from]] food.',
        dragDistractors: ['hat', 'use gel', 'any', 'above'],
        explanation: 'Aprons stay food-side, hands get washed after waste runs, and chemicals live labelled and separated from food — never above it.',
        difficulty: 'medium',
        categoryTag: 'Waste & Chemicals',
      },
      {
        id: 'fs4q8',
        text: 'Clean-as-you-go means all cleaning is completed at the end of the shift in one deep clean.',
        type: 'true_false',
        options: ['True', 'False'],
        correctAnswer: 'False',
        explanation: 'It means the opposite: spills and debris are dealt with as part of making each order, so bacteria never get a warm afternoon to multiply.',
        difficulty: 'easy',
        categoryTag: 'Clean As You Go',
      },
    ],
  },
];
