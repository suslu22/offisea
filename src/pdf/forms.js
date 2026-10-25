// PDF form doldurma: ekranda girilen değerler kaydederken PDF'in kendi form alanlarına yazılır
// (dosya başka programlarda da doldurulmuş görünür ve alanlar düzenlenebilir kalır).
// PDF içindeki form betikleri (JavaScript) hiçbir zaman çalıştırılmaz.
import { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } from '@cantoo/pdf-lib';

export async function fillForm(doc, values, getFont) {
  let form;
  try { form = doc.getForm(); } catch { return; }
  let font = null;
  const textFont = async () => (font || (font = (await getFont('sans', false, false)).font));
  for (const [name, v] of Object.entries(values)) {
    let f = null;
    try { f = form.getFieldMaybe(name); } catch { f = null; }
    if (!f) continue;
    try {
      if (f.isReadOnly()) continue;
      if (f instanceof PDFTextField) {
        const str = String(v == null ? '' : v);
        const max = f.getMaxLength();
        f.setText(max ? str.slice(0, max) : str);
        f.updateAppearances(await textFont());
      } else if (f instanceof PDFCheckBox) {
        if (v === true || (typeof v === 'string' && v && v !== 'Off')) f.check(); else f.uncheck();
      } else if (f instanceof PDFRadioGroup) {
        if (typeof v === 'string' && v && v !== 'Off') f.select(v); else f.clear();
      } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        const arr = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x);
        if (arr.length) f.select(arr.length === 1 ? arr[0] : arr); else f.clear();
        f.updateAppearances(await textFont());
      }
    } catch (e) {
      console.warn('Form alanı doldurulamadı:', name, e);
    }
  }
  // XFA (eski Adobe formları) verisi kalırsa bazı programlar yeni değerleri göstermez
  try { if (form.hasXFA()) form.deleteXFA(); } catch { /* yok say */ }
}
