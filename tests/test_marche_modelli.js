import fetch from 'node-fetch';

// Test API CarQuery per marche
async function testMarche() {
  try {
    const res = await fetch('https://www.carqueryapi.com/api/0.3/?cmd=getMakes&sold_in_us=1&callback=?');
    const text = await res.text();
    const jsonStr = text.replace(/^\?\(|\);$/g, ''); // rimuove JSONP
    const data = JSON.parse(jsonStr);
    console.log('Marche disponibili:', data.Makes.slice(0, 10).map(m => m.make_display)); // mostro solo prime 10
  } catch (err) {
    console.error('Errore marche:', err);
  }
}

// Test API CarQuery per modelli
async function testModelli(marca) {
  try {
    const res = await fetch(`https://www.carqueryapi.com/api/0.3/?cmd=getModels&make=${marca}&callback=?`);
    const text = await res.text();
    const jsonStr = text.replace(/^\?\(|\);$/g, '');
    const data = JSON.parse(jsonStr);
    console.log(`Modelli per ${marca}:`, data.Models.slice(0, 10).map(m => m.model_name));
  } catch (err) {
    console.error('Errore modelli:', err);
  }
}

// Lancia i test
(async () => {
  await testMarche();
  await testModelli('Toyota'); // cambia marca per testare altre
})();