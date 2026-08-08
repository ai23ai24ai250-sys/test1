/**
 * Egyptian Regions & 3-Part Address Helper.
 * Ported verbatim from js/utils/formatters.js (legacy).
 * Pure data + localStorage-backed custom-city persistence + DOM bind helpers.
 */

export const EGYPT_GOVERNORATES = {
  'القاهرة': ['مدينة نصر', 'مصر الجديدة', 'المعادي', 'التجمع الخامس', 'حلوان', 'شبرا', 'وسط البلد', 'عين شمس', 'المقطم', 'النزهة', 'الزمالك', 'المرج', 'السلام', 'الأميرية', 'الزيتون', 'الشرابية', 'روض الفرج', 'بولاق', 'باب الشعرية', 'الموسكي', 'الجمالية', 'الدرب الأحمر', 'الخليفة', 'المطرية', 'الوايلي', 'السيدة زينب', 'المعصرة', 'البساتين', 'دار السلام', 'طرة', '15 مايو', 'القطامية', 'مدينة الشروق', 'مدينة بدر', 'قصر النيل', 'الزاوية الحمراء', 'حدائق القبة'],
  'الجيزة': ['الدقي', 'المهندسين', 'الهرم', 'فيصل', '6 أكتوبر', 'الشيخ زايد', 'إمبابة', 'العجوزة', 'العياط', 'البدرشين', 'الصف', 'أطفيح', 'الواحات البحرية', 'بولاق الدكرور', 'الوراق', 'كرداسة', 'أبو النمرس', 'الحوامدية', 'منشأة القناطر', 'سقارة', 'المنصورية', 'نزلة السمان', 'المنيب', 'المريوطية', 'أوسيم'],
  'الإسكندرية': ['سموحة', 'المنتزه', 'سيدي بشر', 'العجمي', 'محرم بك', 'ستانلي', 'ميامي', 'برج العرب', 'عامرية', 'باب شرقي', 'الشاطبي', 'سيدي جابر', 'لوران', 'فيكتوريا', 'رشدي', 'سابا باشا', 'العصافرة', 'المندرة', 'سيدي كرير', 'أبو قير', 'الدخيلة', 'المنشية', 'الرمل', 'غيط العنب', 'كرموز', 'محطة الرمل', 'أنطونيادس', 'الإبراهيمية', 'الظاهرية', 'كوم الشقافة'],
  'الدقهلية': ['المنصورة', 'ميت غمر', 'طلخا', 'دكرنس', 'سنبلاوين', 'شربين', 'منزلة', 'بلقاس', 'أجا', 'بني عبيد', 'نبروه', 'تمي الأمديد', 'ميت سلسيل', 'ميت سويد', 'الجمالية', 'المنصورة الجديدة', 'محلة دمنة', 'شطا', 'ميت أبو غريب'],
  'الشرقية': ['الزقازيق', 'العاشر من رمضان', 'بلبيس', 'أبو حماد', 'فاقوس', 'منيا القمح', 'أبو كبير', 'ديرب نجم', 'الحسينية', 'أولاد صقر', 'ههيا', 'كفر صقر', 'صان الحجر', 'القرين', 'الإبراهيمية', 'مشتول السوق', 'القنايات', 'الزوامل', 'منشأة أبو عمر', 'السعادة'],
  'القليوبية': ['بنها', 'شبرا الخيمة', 'العبور', 'طوخ', 'قليوب', 'الخانكة', 'القناطر الخيرية', 'شبين القناطر', 'كفر شكر', 'الخصوص', 'بهتيم', 'مسطرد', 'القلج', 'سندنهور', 'الصفا', 'العبور'],
  'الغربية': ['طنطا', 'المحلة الكبرى', 'زفتى', 'كفر الزيات', 'سمنود', 'بسيون', 'قطور', 'السنطة', 'برما', 'كفر شبرا', 'المحلة', 'بلكيم', 'الغربية', 'شبرا الكبيرة'],
  'المنوفية': ['شبين الكوم', 'منوف', 'أشمون', 'السادات', 'قويسنا', 'تلا', 'بركة السبع', 'سرس الليان', 'الباجور', 'الشهداء', 'منشأة سلطان', 'منوف الجديدة', 'ميت برة'],
  'البحيرة': ['دمنهور', 'كفر الدوار', 'إيتاي البارود', 'أبو حمص', 'كوم حمادة', 'رشيد', 'حوش عيسى', 'إدكو', 'أبو المطامير', 'الدلنجات', 'شبراخيت', 'المحمودية', 'وادي النطرون', 'بدر', 'الرحمانية', 'نوبار', 'كفر الدوار الجديدة'],
  'كفر الشيخ': ['كفر الشيخ', 'دسوق', 'بلطيم', 'سيدي سالم', 'بيلا', 'قلين', 'الرياض', 'فوه', 'مطوبس', 'الحامول', 'كفر الشيخ الجديدة', 'مركز البرلس', 'باقوصة'],
  'الفيوم': ['الفيوم', 'سنورس', 'طامية', 'إطسا', 'أبشواي', 'يوسف الصديق', 'أهناسيا', 'شدموه', 'سيلا', 'الفيوم الجديدة', 'منشأة طلعت'],
  'بني سويف': ['بني سويف', 'الواسطى', 'ببا', 'ناصر', 'إهناسيا', 'الفشن', 'سمسطا', 'بني سويف الجديدة', 'الشريفية', 'مصر العربية'],
  'المنيا': ['المنيا', 'ملوي', 'بني مزار', 'أبو قرقاص', 'مغاغة', 'سمالوط', 'دير مواس', 'العدوة', 'مطاي', 'المنيا الجديدة', 'منها ابنوب', 'بني خالد'],
  'أسيوط': ['أسيوط', 'ديروط', 'أبو تيج', 'القوصية', 'منفلوط', 'أبنوب', 'ساحل سليم', 'البداري', 'الغنايم', 'صدفا', 'الفتح', 'أسيوط الجديدة', 'ديروط الشريف'],
  'سوهاج': ['سوهاج', 'طهطا', 'أخميم', 'جرجا', 'البلينا', 'المراغة', 'المنشأة', 'ساقلتة', 'جهينة', 'طما', 'دار السلام', 'سوهاج الجديدة', 'أخميم الجديدة'],
  'قنا': ['قنا', 'نجع حمادي', 'قوص', 'دشنا', 'أبو تشت', 'فرشوط', 'الوقف', 'نقادة', 'قفط', 'دندرة', 'قنا الجديدة', 'الكرنك الجديدة'],
  'الأقصر': ['الأقصر', 'أرمنت', 'إسنا', 'القرنة', 'الطود', 'الزينية', 'البياضية', 'البعيرات', 'الأقصر الجديدة', 'الريانية'],
  'أسوان': ['أسوان', 'كوم أمبو', 'إدفو', 'نصر النوبة', 'دراو', 'كلابشة', 'السد العالي', 'الرديسية', 'أبوسمبل', 'أسوان الجديدة', 'سبعة', 'وادي كركر'],
  'بورسعيد': ['حي الشرق', 'حي العرب', 'حي المناخ', 'حي الزهور', 'بورفؤاد', 'حي الضواحي', 'حي غرب', 'حي جنوب', 'حي الشرق', 'مدينة السلام', 'قرية بورسعيد'],
  'السويس': ['حي السويس', 'حي الأربعين', 'حي عتاقة', 'حي فيصل', 'حي الجناين', 'عرب المعمل', 'السويس الجديدة', 'كوبري أكتوبر'],
  'الإسماعيلية': ['الإسماعيلية', 'التل الكبير', 'فايد', 'القنطرة شرق', 'القنطرة غرب', 'أبو صوير', 'القصاصين', 'نفيشة', 'التمساح', 'المنايف', 'سرابيوم', 'الإسماعيلية الجديدة'],
  'دمياط': ['دمياط', 'راس البر', 'دمياط الجديدة', 'فارسكور', 'الزرقا', 'كفر سعد', 'كفر البطيخ', 'عزبة البرج', 'السرو', 'كفر ميت أبو غالب', 'دمياط القديمة'],
  'البحر الأحمر': ['الغردقة', 'سفاجا', 'القصير', 'مرسى علم', 'رأس غارب', 'الشلاتين', 'أبو رماد', 'حماطة', 'الغردقة الجديدة', 'وادي الجمال'],
  'جنوب سيناء': ['شرم الشيخ', 'دهب', 'نويبع', 'طور سيناء', 'طابا', 'رأس سدر', 'أبو زنيمة', 'سانت كاترين', 'النقب', 'أبو رديس'],
  'شمال سيناء': ['العريش', 'الشيخ زويد', 'رفح', 'بئر العبد', 'الحسنة', 'نخل', 'رمانة', 'قاطية', 'الجورة', 'العريش الجديدة'],
  'مطروح': ['مرسى مطروح', 'العلمين', 'الضبعة', 'سيوة', 'النجيلة', 'الحمام', 'رأس الحكمة', 'براني', 'السلوم', 'فوكا', 'مطروح الجديدة', 'أبيار'],
  'الوادي الجديد': ['الخارجة', 'الداخلة', 'الفرافرة', 'باريس', 'بلاط', 'موط', 'الجديدة', 'القصر', 'الشركة']
};

export const CITY_CUSTOM_STORAGE_KEY = 'city_custom_entries';

export function getCustomCities(governorate) {
  try {
    const raw = localStorage.getItem(CITY_CUSTOM_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    if (governorate) return (all[governorate] || []).filter(Boolean);
    return all;
  } catch {
    return governorate ? [] : {};
  }
}

export function addCustomCity(governorate, city) {
  const g = String(governorate || '').trim();
  const c = String(city || '').trim();
  if (!g || !c) return false;
  const base = EGYPT_GOVERNORATES[g] || [];
  if (base.includes(c) || getCustomCities(g).includes(c)) return false;
  const all = getCustomCities();
  all[g] = all[g] || [];
  all[g].push(c);
  try { localStorage.setItem(CITY_CUSTOM_STORAGE_KEY, JSON.stringify(all)); } catch { /* storage full */ }
  return true;
}

export function getCitiesForGovernorate(governorate) {
  const base = EGYPT_GOVERNORATES[governorate] || [];
  const custom = getCustomCities(governorate);
  if (!custom.length) return base;
  return base.concat(custom.filter(c => !base.includes(c)));
}

export function citySelectOptions(governorate, selectedCity) {
  const cities = getCitiesForGovernorate(governorate);
  let html = '<option value="">اختر المدينة / المركز</option>';
  cities.forEach(c => {
    html += `<option value="${String(c).replace(/"/g, '&quot;')}"${c === selectedCity ? ' selected' : ''}>${c}</option>`;
  });
  html += `<option value="__other__"${selectedCity && !cities.includes(selectedCity) ? ' selected' : ''}>أخرى (إدخال يدوي)...</option>`;
  return html;
}

/** Binds a governorate select to a city select and an optional manual-city input. */
export function setupCitySelect(opts) {
  const govSel = opts.governorateSelect;
  const citySel = opts.citySelect;
  const manualInput = opts.manualInput;
  if (!govSel || !citySel) return;

  const refreshCities = (governorate, selectedCity) => {
    const gov = governorate || govSel.value || '';
    citySel.innerHTML = citySelectOptions(gov, selectedCity);
  };

  govSel.addEventListener('change', () => {
    refreshCities(govSel.value, '');
    if (manualInput) {
      manualInput.value = '';
      manualInput.style.display = 'none';
    }
    if (opts.onCityChange) opts.onCityChange('', citySel.value);
  });

  citySel.addEventListener('change', () => {
    const isOther = citySel.value === '__other__';
    if (manualInput) {
      manualInput.style.display = isOther ? 'block' : 'none';
      if (!isOther) manualInput.value = '';
    }
    if (!isOther) {
      const city = getCitiesForGovernorate(govSel.value).includes(citySel.value) ? citySel.value : '';
      if (opts.onCityChange) opts.onCityChange(city, citySel.value);
    }
  });

  if (manualInput) {
    manualInput.style.display = 'none';
    manualInput.addEventListener('change', () => {
      const val = manualInput.value.trim();
      if (!val) return;
      addCustomCity(govSel.value, val);
      citySel.innerHTML = citySelectOptions(govSel.value, val);
      if (opts.onCityChange) opts.onCityChange(val, citySel.value);
    });
  }
}

/** reads the effective city from a citySelect + manualInput pair */
export function getEffectiveCity(citySelect, manualInput) {
  if (!citySelect) return '';
  const manualVal = manualInput ? manualInput.value.trim() : '';
  if (citySelect.value === '__other__') return manualVal;
  return citySelect.value;
}

/** Parse combined 3-part address string into components */
export function parseAddressComponents(fullAddressStr) {
  const defaultGov = 'القاهرة';
  const defaultCity = EGYPT_GOVERNORATES['القاهرة'][0];
  if (!fullAddressStr) return { governorate: defaultGov, city: defaultCity, details: '' };

  const parts = fullAddressStr.split(' - ');
  if (parts.length >= 2 && EGYPT_GOVERNORATES[parts[0]]) {
    return {
      governorate: parts[0],
      city: parts[1],
      details: parts.slice(2).join(' - ')
    };
  }
  return { governorate: defaultGov, city: defaultCity, details: fullAddressStr };
}

/**
 * Resolve a free-form Egyptian address string (from AI form-fill, chat, or paste)
 * into the tri-state address fields { governorate, city, details }.
 * Falls back to matching a known city name anywhere in the string, then to the
 * fallback governorate. Unlike parseAddressComponents it never fabricates a city.
 */
export function matchEgyptAddress(addressStr, fallbackGov = 'القاهرة') {
  const govs = Object.keys(EGYPT_GOVERNORATES);
  const str = String(addressStr || '').trim();
  if (!str) return { governorate: fallbackGov, city: '', details: '' };

  const parts = str.split(/\s*-\s*/).map(s => s.trim()).filter(Boolean);
  let governorate = '';
  let city = '';
  let details = '';

  if (parts.length >= 2 && EGYPT_GOVERNORATES[parts[0]]) {
    governorate = parts[0];
    city = parts[1];
    details = parts.slice(2).join(' - ');
  } else {
    for (const g of govs) {
      const hit = getCitiesForGovernorate(g).find(c => str.includes(c));
      if (hit && hit.length > city.length) {
        governorate = g;
        city = hit;
      }
    }
    if (!governorate && parts.length === 1 && EGYPT_GOVERNORATES[parts[0]]) {
      governorate = parts[0];
    }
    if (!governorate) details = str;
  }

  return { governorate: governorate || fallbackGov, city, details };
}
