/* SplitBook — turn a spoken or typed sentence into an entry.
   Pure functions, no DOM: SBVoice.parse(text, ctx) → { type, amount, desc, cat, date, repeat, bookId, paidBy, sel, loan, names, warnings, ... }
   Understands English, हिन्दी, বাংলা, मराठी, తెలుగు, தமிழ் (and Hinglish), e.g.
     "Lunch 250 yesterday" · "Got salary 50000" · "Dinner 1200 with Ravi" · "Netflix 649 every month" · "ढाई सौ रुपये चाय" */
(function (root) {
  'use strict';
  const DIG = [[0x0966, 0x096F], [0x09E6, 0x09EF], [0x0C66, 0x0C6F], [0x0BE6, 0x0BEF]];
  const norm = s => {
    let t = String(s == null ? '' : s).normalize('NFC').replace(/[​-‍﻿]/g, '').replace(/़/g, '').toLowerCase();
    for (const [a, b] of DIG) t = t.replace(new RegExp('[\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0') + ']', 'g'), d => String(d.charCodeAt(0) - a));
    return t;
  };
  const N = w => w.split(/\s+/).filter(Boolean).map(norm);
  const setOf = w => new Set(N(w));
  const mapOf = (obj) => { const m = {}; for (const [k, v] of Object.entries(obj)) for (const w of N(k)) m[w] = v; return m; };

  /* ---------- numbers ---------- */
  const SMALL = mapOf({
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
    'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,
    'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'छे': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12, 'तेरह': 13, 'चौदह': 14, 'पंद्रह': 15, 'पन्द्रह': 15, 'सोलह': 16, 'सत्रह': 17, 'अठारह': 18, 'उन्नीस': 19,
    'बीस': 20, 'इक्कीस': 21, 'बाईस': 22, 'तेईस': 23, 'चौबीस': 24, 'पच्चीस': 25, 'छब्बीस': 26, 'सत्ताईस': 27, 'अट्ठाईस': 28, 'उनतीस': 29, 'तीस': 30, 'इकतीस': 31, 'बत्तीस': 32, 'तैंतीस': 33, 'चौंतीस': 34, 'पैंतीस': 35, 'छत्तीस': 36, 'सैंतीस': 37, 'अड़तीस': 38, 'उनतालीस': 39,
    'चालीस': 40, 'इकतालीस': 41, 'बयालीस': 42, 'तैंतालीस': 43, 'चौवालीस': 44, 'पैंतालीस': 45, 'छियालीस': 46, 'सैंतालीस': 47, 'अड़तालीस': 48, 'उनचास': 49, 'पचास': 50, 'इक्यावन': 51, 'बावन': 52, 'तिरपन': 53, 'चौवन': 54, 'पचपन': 55, 'छप्पन': 56, 'सत्तावन': 57, 'अट्ठावन': 58, 'उनसठ': 59,
    'साठ': 60, 'इकसठ': 61, 'बासठ': 62, 'तिरसठ': 63, 'चौंसठ': 64, 'पैंसठ': 65, 'छियासठ': 66, 'सड़सठ': 67, 'अड़सठ': 68, 'उनहत्तर': 69, 'सत्तर': 70, 'इकहत्तर': 71, 'बहत्तर': 72, 'तिहत्तर': 73, 'चौहत्तर': 74, 'पचहत्तर': 75, 'छिहत्तर': 76, 'सतहत्तर': 77, 'अठहत्तर': 78, 'उनासी': 79,
    'अस्सी': 80, 'इक्यासी': 81, 'बयासी': 82, 'तिरासी': 83, 'चौरासी': 84, 'पचासी': 85, 'छियासी': 86, 'सत्तासी': 87, 'अट्ठासी': 88, 'नवासी': 89, 'नब्बे': 90, 'इक्यानवे': 91, 'बानवे': 92, 'तिरानवे': 93, 'चौरानवे': 94, 'पचानवे': 95, 'छियानवे': 96, 'सत्तानवे': 97, 'अट्ठानवे': 98, 'निन्यानवे': 99,
    'ढाई': 2.5, 'डेढ़': 1.5, 'सवा': 1.25,
    'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'paanch': 5, 'panch': 5, 'chhe': 6, 'saat': 7, 'aath': 8, 'nau': 9, 'das': 10, 'gyarah': 11, 'barah': 12, 'pandrah': 15, 'bees': 20, 'pachchis': 25, 'tees': 30, 'chalis': 40, 'pachas': 50, 'saath': 60, 'sattar': 70, 'assi': 80, 'nabbe': 90, 'dhai': 2.5, 'dedh': 1.5, 'sawa': 1.25,
  });
  const MULT = mapOf({
    'hundred': 100, 'sau': 100, 'सौ': 100, 'শো': 100, 'শত': 100, 'शंभर': 100, 'शे': 100, 'వంద': 100, 'నూరు': 100, 'நூறு': 100,
    'thousand': 1e3, 'k': 1e3, 'hazaar': 1e3, 'hazar': 1e3, 'hajar': 1e3, 'हज़ार': 1e3, 'हजार': 1e3, 'হাজার': 1e3, 'వేలు': 1e3, 'వెయ్యి': 1e3, 'ஆயிரம்': 1e3, 'ஆயிரத்து': 1e3,
    'lakh': 1e5, 'lakhs': 1e5, 'lac': 1e5, 'lacs': 1e5, 'लाख': 1e5, 'লাখ': 1e5, 'লক্ষ': 1e5, 'లక్ష': 1e5, 'லட்சம்': 1e5, 'லட்ச': 1e5,
    'crore': 1e7, 'crores': 1e7, 'karod': 1e7, 'करोड़': 1e7, 'करोड': 1e7, 'কোটি': 1e7, 'कोटी': 1e7, 'కోటి': 1e7, 'கோடி': 1e7,
  });
  const CURRENCY = setOf('rs rs. rupee rupees rupaye rupaiye inr ₹ रुपये रुपए रुपया रू टका টাকা রুপি రూపాయలు రూపాయి రూ ரூபாய் ரூ');
  const MONTHS = mapOf({ 'january jan': 1, 'february feb': 2, 'march mar': 3, 'april apr': 4, 'may': 5, 'june jun': 6, 'july jul': 7, 'august aug': 8, 'september sep sept': 9, 'october oct': 10, 'november nov': 11, 'december dec': 12,
    'जनवरी': 1, 'फरवरी': 2, 'मार्च': 3, 'अप्रैल': 4, 'मई': 5, 'जून': 6, 'जुलाई': 7, 'अगस्त': 8, 'सितंबर': 9, 'अक्टूबर': 10, 'नवंबर': 11, 'दिसंबर': 12 });
  const ORD = setOf('st nd rd th');

  /* ---------- type, repeat, date ---------- */
  const INCOME = setOf('received receive earned earning earnings salary income credited bonus payday dividend mila mile mili kamai वेतन सैलरी तनख्वाह आय कमाई कमाए बोनस मिला मिले मिली বেতন আয় বোনাস পেলাম পেয়েছি पगार उत्पन्न मिळाले मिळाला मिळाली జీతం ఆదాయం బోనస్ వచ్చింది వచ్చాయి சம்பளம் வருமானம் போனஸ் கிடைத்தது வந்தது');
  const GENERIC_INC = setOf('received receive earned credited mila mile mili मिला मिले मिली পেলাম পেয়েছি मिळाले मिळाला मिळाली వచ్చింది వచ్చాయి கிடைத்தது வந்தது');
  const INCOME_PHRASE = /got paid|pay ?day|जमा हुआ|জমা/;
  const EXPENSE_WORDS = setOf('spent bought paid pay खर्च खर्चा खरीदा खरीदी খরচ কিনলাম খর্চ खर्च खरेदी ఖర్చు కొన్నాను செலவு வாங்கினேன்');
  const REPEAT = [
    ['monthly', /every month|each month|per month|monthly|हर महीने|हर माह|मासिक|প্রতি মাসে|মাসিক|दर महिन्याला|दर महिना|ప్రతి నెల|నెలవారీ|ஒவ்வொரு மாதம்|மாதாந்திர/],
    ['weekly', /every week|each week|weekly|हर हफ्ते|हर सप्ताह|साप्ताहिक|প্রতি সপ্তাহে|সাপ্তাহিক|दर आठवड्याला|ప్రతి వారం|ஒவ்வொரு வாரம்|வாராந்திர/],
    ['yearly', /every year|each year|yearly|annually|हर साल|वार्षिक|প্রতি বছর|বার্ষিক|दर वर्षी|ప్రతి సంవత్సరం|ஒவ்வொரு ஆண்டு|ஆண்டுதோறும்/],
  ];
  const DAYS = [
    [0, /\b(today|aaj)\b|आज|আজ|ఈరోజు|ఇవాళ|இன்று/],
    [2, /day before yesterday|\bparso\b|परसों|পরশু|परवा|మొన్న|முந்தாநாள்/],
    [1, /yesterday|last night|\bkal\b|कल|गतकाल|গতকাল|গত রাত|काल|నిన్న|நேற்று|நேத்து/],
  ];
  const AGO = /(\d+)\s*(?:days?|din|दिन|দিন|दिवस|రోజులు|நாட்கள்)\s*(?:ago|pehle|पहले|আগে|पूर्वी|క్రితం|முன்)/;

  /* ---------- categories (token match: Latin exact/plural, Indic prefix) ---------- */
  const CAT = [
    ['🔁', 'Subscription', 'netflix spotify prime hotstar youtube subscription icloud membership नेटफ्लिक्स स्पॉटिफाई सब्सक्रिप्शन हॉटस्टार प्राइम নেটফ্লিক্স স্পটিফাই সাবস্ক্রিপশন সদস্যতা नेटफ्लिक्स सबस्क्रिप्शन నెట్ఫ్లిక్స్ సబ్స్క్రిప్షన్ நெட்ஃபிளிக்ஸ் சந்தா சப்ஸ்கிரிப்ஷன்'],
    ['🏥', 'Health', 'medicine doctor hospital pharmacy medical dentist clinic tablet tablets दवाई दवा डॉक्टर अस्पताल दवाखाना ওষুধ ডাক্তার হাসপাতাল औषध गोळ्या दवाखाना रुग्णालय మందులు డాక్టర్ ఆసుపత్రి மருந்து மருத்துவர் டாக்டர் மருத்துவமனை'],
    ['🚗', 'Transport', 'taxi cab uber ola auto rickshaw petrol diesel fuel bus train metro ticket parking toll rapido टैक्सी कैब उबर ओला ऑटो रिक्शा पेट्रोल डीज़ल बस ट्रेन मेट्रो टिकट पार्किंग टोल ট্যাক্সি ক্যাব উবার অটো রিকশা পেট্রল বাস ট্রেন মেট্রো টিকিট टॅक्सी कॅब रिक्षा रेल्वे तिकीट టాక్సీ క్యాబ్ ఆటో పెట్రోల్ బస్సు రైలు మెట్రో టికెట్ டாக்ஸி கேப் ஆட்டோ பெட்ரோல் பேருந்து ரயில் மெட்ரோ டிக்கெட்'],
    ['✈️', 'Travel', 'flight hotel trip holiday booking resort visa फ्लाइट होटल यात्रा सफर छुट्टी बुकिंग ফ্লাইট হোটেল ভ্রমণ ট্রিপ फ्लाइट हॉटेल सहल प्रवास ఫ్లైట్ హోటల్ ప్రయాణం ట్రిప్ விமானம் ஹோட்டல் பயணம் டிரிப்'],
    ['🍽️', 'Food', 'lunch dinner breakfast coffee tea chai snack snacks food meal pizza burger biryani restaurant cafe swiggy zomato लंच डिनर नाश्ता खाना चाय कॉफी रेस्टोरेंट पिज़्ज़ा पिज्जा बिरयानी समोसा দুপুরের রাতের খাবার খাওয়া চা কফি নাস্তা রেস্তোরাঁ বিরিয়ানি লাঞ্চ ডিনার जेवण चहा हॉटेल बिर्याणी భోజనం టిఫిన్ టీ కాఫీ లంచ్ డిన్నర్ బిర్యానీ சாப்பாடு உணவு டீ காபி டிபன் லஞ்ச் டின்னர் பிரியாணி'],
    ['🛒', 'Groceries', 'groceries grocery vegetables veggies milk fruits kirana supermarket bigbasket blinkit zepto सब्ज़ी सब्जी सब्जियां दूध किराना फल राशन ग्रोसरी বাজার সবজি দুধ মুদি ফল भाजी भाजीपाला किराणा फळे కూరగాయలు పాలు కిరాణా పండ్లు காய்கறி பால் மளிகை பழம்'],
    ['💡', 'Bills', 'electricity bill recharge wifi internet broadband gas water phone mobile dth बिजली बिल रिचार्ज वाईफाई इंटरनेट गैस पानी फोन বিদ্যুৎ বিল রিচার্জ ওয়াইফাই ইন্টারনেট গ্যাস वीज वायफाय गॅस पाणी కరెంట్ బిల్లు రీఛార్జ్ వైఫై ఇంటర్నెట్ గ్యాస్ నీళ్లు மின்சாரம் பில் ரீசார்ஜ் வைஃபை இணையம் கேஸ் தண்ணீர்'],
    ['🏠', 'Home', 'rent maid repair furniture house किराया मेड कामवाली मरम्मत ভাড়া মেরামত भाडे मोलकरीण दुरुस्ती అద్దె పనిమనిషి வாடகை'],
    ['🎬', 'Fun', 'movie cinema film game concert party bowling फिल्म सिनेमा मूवी गेम पार्टी সিনেমা মুভি ফিল্ম গেম পার্টি चित्रपट मूव्ही సినిమా మూవీ గేమ్ பார்ட்டி சினிமா படம் மூவி கேம்'],
    ['🎁', 'Gift', 'gift present birthday उपहार तोहफा गिफ्ट जन्मदिन উপহার জন্মদিন भेट బహుమతి పుట్టినరోజు பரிசு'],
  ];
  const INCOME_CAT = [
    ['💼', 'Salary', 'salary payday वेतन सैलरी तनख्वाह पगार বেতন జీతం சம்பளம்'],
    ['💻', 'Freelance', 'freelance project client फ्रीलांस প্রজেক্ট फ्रीलान्स ఫ్రీలాన్స్ ஃப்ரீலான்ஸ்'],
    ['📈', 'Investing', 'interest dividend investment ब्याज निवेश व्याज गुंतवणूक সুদ বিনিয়োগ వడ్డీ పెట్టుబడి வட்டி முதலீடு'],
    ['↩️', 'Refund', 'refund cashback रिफंड परतावा রিফান্ড రీఫండ్ பணத்திருப்பம்'],
    ['🎁', 'Gift', 'gift उपहार भेट উপহার బహుమతి பரிசு'],
  ].map(r => r);
  const prep = list => list.map(([ico, name, words]) => ({ ico, name, words: N(words) }));
  const CATS = prep(CAT), ICATS = prep(INCOME_CAT);
  const isLatin = w => /^[a-z]+$/.test(w);
  const catOf = (tokens, table) => {
    for (const c of table) for (const t of tokens) for (const w of c.words) {
      if (isLatin(w) ? (t === w || t === w + 's') : (t.startsWith(w) && t.length <= w.length + 4)) return c;
    }
    return null;
  };

  /* ---------- loans ---------- */
  const LENT = /\b(lent|loaned)\b|उधार (?:दिए|दिया|दिये|दी)|ধার দি|उसने दिले|उधार दिले|అప్పు ఇచ్చ|கடன் கொடு/;
  const BORROW = /\bborrow(?:ed|ing)?\b|उधार (?:लिया|लिये|ली)|ধার নি|उसने घेत|उधार घेत|అప్పు తీసు|கடன் வாங்/;

  /* ---------- stop words (removed from the description) ---------- */
  const STOP = new Set([...N('for on at the a an to of from in with and spent paid pay pays paying bought buy got get received receive rs rupees rupee inr today yesterday ago every month week year monthly weekly yearly day days before last night added add expense income i my me was is by split between among lent loaned borrowed loan kal aaj parso din pehle mila mile hai tha'),
    ...N('के का की को में से पर लिए रुपये रुपए रुपया रू खर्च खर्चा किया करा दिए दिया दिये मिला मिले मिली आज कल परसों हर महीने हफ्ते साल मैंने मुझे मेरा मेरी पहले दिन ने है था साथ उधार'),
    ...N('টাকা গতকাল আজ পরশু প্রতি মাসে সপ্তাহে বছর পেলাম পেয়েছি খরচ করলাম দিলাম আমি আমার জন্য এর কে ধার'),
    ...N('रुपये रुपया काल आज परवा दर महिन्याला आठवड्याला वर्षी मिळाले मिळाला मिळाली खर्च केला दिले मी माझे साठी ला ने सोबत उसने'),
    ...N('రూపాయలు రూపాయి నిన్న ఈరోజు ఇవాళ మొన్న ప్రతి నెల వారం సంవత్సరం వచ్చింది వచ్చాయి ఖర్చు చేశాను ఇచ్చాను నేను నా కోసం అప్పు'),
    ...N('ரூபாய் நேற்று இன்று முந்தாநாள் ஒவ்வொரு மாதம் வாரம் ஆண்டு கிடைத்தது வந்தது செலவு செய்தேன் கொடுத்தேன் நான் என் க்கு ஆக கடன்')]);
  const isoOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoOf(d); };

  function tokenize(text) {
    let t = norm(text).replace(/(\d),(?=\d{2,3}\b)/g, '$1').replace(/₹/g, ' ₹ ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/(\d)([^\d\s.])/g, '$1 $2').replace(/([^\d\s.])(\d)/g, '$1 $2');
    return t.split(/[\s,;:!?()"“”‘’।|/\\]+/).filter(Boolean);
  }
  const numVal = t => /^\d+(?:\.\d+)?$/.test(t) ? parseFloat(t) : (t in SMALL ? SMALL[t] : null);
  function runValue(tokens) {
    let total = 0, cur = 0, seen = false;
    for (const t of tokens) {
      const v = numVal(t);
      if (v !== null) { cur += v; seen = true; }
      else if (t in MULT) { const m = MULT[t]; if (m === 100) cur = (cur || 1) * 100; else { total += (cur || 1) * m; cur = 0; } seen = true; }
    }
    return seen ? total + cur : null;
  }

  function parse(text, ctx) {
    ctx = ctx || {};
    const today = ctx.today || isoOf(new Date()), people = ctx.people || [], books = (ctx.books || []).filter(b => !b.deleted);
    const raw = String(text || '').trim(), n = norm(raw), tokens = tokenize(raw), used = new Array(tokens.length).fill(false);
    const out = { text: raw, type: 'expense', amount: null, desc: '', cat: '🧾', catName: 'Other', date: today, repeat: '', bookId: ctx.personalId || null, paidBy: ctx.meId || null, sel: [], loan: null, names: [], warnings: [] };
    if (!raw) { out.warnings.push('empty'); return out; }

    // --- date
    let m = n.match(AGO);
    if (m) { out.date = addDays(today, -parseInt(m[1], 10)); tokens.forEach((t, i) => { if (/^\d+$/.test(t) && t === m[1]) used[i] = true; }); }
    else for (const [off, re] of DAYS) if (re.test(n)) { out.date = addDays(today, -off); break; }
    // explicit "5th november" / "5 nov"
    for (let i = 0; i < tokens.length; i++) {
      if (!(tokens[i] in MONTHS)) continue;
      const k = ORD.has(tokens[i - 1] || '') ? i - 2 : i - 1;                       // "5th november" → tokens 5 · th · november
      if (k >= 0 && /^\d+$/.test(tokens[k])) { const day = parseInt(tokens[k], 10);
        if (day >= 1 && day <= 31) { const y = +today.slice(0, 4); let d = `${y}-${String(MONTHS[tokens[i]]).padStart(2, '0')}-${String(day).padStart(2, '0')}`; if (d > today) d = `${y - 1}${d.slice(4)}`; out.date = d; for (let q = k; q <= i; q++) used[q] = true; } }
    }
    // --- repeat
    for (const [k, re] of REPEAT) if (re.test(n)) { out.repeat = k; break; }
    // --- amount: runs of number tokens
    const runs = []; let i = 0;
    while (i < tokens.length) {
      const isNum = j => j < tokens.length && !used[j] && (numVal(tokens[j]) !== null || tokens[j] in MULT);
      if (isNum(i)) { let j = i; while (j + 1 < tokens.length && (isNum(j + 1) || (tokens[j + 1] === 'and' && isNum(j + 2)))) j++; runs.push([i, j]); i = j + 1; } else i++;
    }
    const cand = runs.map(([a, b]) => ({ a, b, v: runValue(tokens.slice(a, b + 1).filter(t => t !== 'and')), cur: CURRENCY.has(tokens[a - 1]) || CURRENCY.has(tokens[b + 1]),
      date: tokens[b + 1] in MONTHS || ORD.has(tokens[b + 1]) })).filter(r => r.v !== null && !r.date);
    const real = cand.filter(r => r.v > 0);
    const pick = real.find(r => r.cur) || real.sort((x, y) => y.v - x.v)[0];
    if (pick) { out.amount = Math.round(pick.v * 100) / 100; for (let k = pick.a; k <= pick.b; k++) used[k] = true; }
    tokens.forEach((t, k) => { if (CURRENCY.has(t)) used[k] = true; });

    // --- type / loan
    const hasIncome = tokens.some(t => INCOME.has(t)) || INCOME_PHRASE.test(n);
    const lent = LENT.test(n), borrowed = BORROW.test(n);
    if (hasIncome && !lent && !borrowed) out.type = 'income';
    // --- people mentioned
    const others = people.filter(p => !p.isMe && !p.deleted);
    const mentioned = [];
    for (const p of others) {
      const parts = N(p.name); if (!parts.length) continue;
      for (let k = 0; k < tokens.length; k++) {
        const hit = parts.length > 1 && parts.every((w, d) => tokens[k + d] === w) ? parts.length : (tokens[k] === parts[0] || (parts[0].length >= 3 && tokens[k].startsWith(parts[0]) && tokens[k].length <= parts[0].length + 2 && !isLatin(parts[0])) ? 1 : 0);
        if (hit) { mentioned.push({ p, at: k, len: hit }); for (let d = 0; d < hit; d++) used[k + d] = true; break; }
      }
    }
    out.names = mentioned.map(x => x.p.name);
    const ids = mentioned.map(x => x.p.id), me = ctx.meId;
    const bookHas = (b, list) => list.every(id => (b.memberIds || []).includes(id));
    const shared = books.filter(b => !b.personal && (b.memberIds || []).includes(me));
    const cur = ctx.currentBookId && shared.find(b => b.id === ctx.currentBookId);
    // --- payer cue
    let payer = null;
    for (const x of mentioned) { const nx = tokens[x.at + x.len], pv = tokens[x.at - 1]; if (['paid', 'pays', 'gave', 'ने', 'ne'].includes(nx) || pv === 'by') payer = x.p.id; }
    // --- book choice
    if (out.type === 'expense' || lent || borrowed) {
      let book = null;
      if (ids.length) book = (cur && bookHas(cur, ids)) ? cur : shared.filter(b => bookHas(b, ids)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
      else if (cur) book = cur;
      if (book) {
        out.bookId = book.id;
        if (lent || borrowed) {
          if (ids.length === 1) { out.loan = lent ? 'lent' : 'borrowed'; out.cat = '💸'; out.catName = 'Loan'; out.paidBy = lent ? me : ids[0]; out.sel = [lent ? ids[0] : me]; }
          else out.warnings.push('loan-needs-one-person');
        } else { out.paidBy = payer || me; out.sel = ids.length ? [me, ...ids.filter(id => id !== me)] : (book.memberIds || []).filter(id => id !== undefined); }
      } else {
        if (ids.length || lent || borrowed) out.warnings.push('no-shared-book');
        out.bookId = ctx.personalId || null; out.paidBy = me; out.sel = me ? [me] : [];
      }
    } else { out.bookId = ctx.personalId || null; out.paidBy = me; out.sel = me ? [me] : []; }

    // --- category
    const rest = tokens.filter((t, k) => !used[k]);
    if (!out.loan) {
      const c = out.type === 'income' ? catOf(rest, ICATS) : catOf(rest, CATS);
      if (c) { out.cat = c.ico; out.catName = c.name; } else if (out.type === 'income') { out.cat = '💼'; out.catName = 'Salary'; }
    }
    // --- description = what is left once everything understood is removed
    const desc = tokens.filter((t, k) => !used[k] && !STOP.has(t) && !(t in MULT) && numVal(t) === null && !(t in MONTHS) && !ORD.has(t) && !CURRENCY.has(t) && !INCOME.has(t) && !EXPENSE_WORDS.has(t));
    // keep original casing/script for the words we kept
    const orig = String(raw).replace(/[​-‍﻿]/g, '').split(/[\s,;:!?()"“”‘’।|]+/).filter(Boolean);
    const keep = new Set(desc);
    let d = orig.filter(w => keep.has(norm(w).replace(/^\.+|\.+$/g, ''))).join(' ').trim();
    if (!d && desc.length) d = desc.join(' ');
    if (!d && out.type === 'income') { const w = orig.find(x => { const t = norm(x); return INCOME.has(t) && !GENERIC_INC.has(t); }); if (w) d = w; }
    out.desc = d ? d.charAt(0).toUpperCase() + d.slice(1) : '';
    if (out.amount === null) out.warnings.push('no-amount');
    return out;
  }
  root.SBVoice = { parse, norm, tokenize, runValue };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SBVoice;
})(typeof window !== 'undefined' ? window : globalThis);
