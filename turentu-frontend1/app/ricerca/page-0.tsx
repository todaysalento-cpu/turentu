'use client';

import { useState } from 'react';

export default function RicercaPage() {
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [posti, setPosti] = useState(1);
  const [risultati, setRisultati] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [errore, setErrore] = useState('');

  const handleSearch = async () => {
    setErrore('');
    setLoading(true);
    setRisultati(null);

    // validazione
    if (!lat || !lon || posti < 1) {
      setErrore('Inserisci latitudine, longitudine e posti validi');
      setLoading(false);
      return;
    }

    try {
      const richiesta = {
        coord: { lat: parseFloat(lat), lon: parseFloat(lon) },
        posti_richiesti: posti,
        km: 10, // valore fisso
        arrivo_datetime: new Date().toISOString(),
      };

      const res = await fetch('http://localhost:3001/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(richiesta),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Errore nella ricerca');
      }

      const data = await res.json();
      setRisultati(data);
    } catch (err: any) {
      console.error(err);
      setErrore(err.message || 'Errore sconosciuto');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>Ricerca Veicoli / Corse (Test)</h1>

      <div style={{ marginBottom: 10 }}>
        <input
          type="number"
          placeholder="Latitudine"
          value={lat}
          onChange={(e) => setLat(e.target.value)}
        />
      </div>
      <div style={{ marginBottom: 10 }}>
        <input
          type="number"
          placeholder="Longitudine"
          value={lon}
          onChange={(e) => setLon(e.target.value)}
        />
      </div>
      <div style={{ marginBottom: 10 }}>
        <input
          type="number"
          placeholder="Posti richiesti"
          value={posti}
          onChange={(e) => setPosti(parseInt(e.target.value) || 1)}
          min={1}
        />
      </div>

      <button onClick={handleSearch} disabled={loading}>
        {loading ? 'Caricamento...' : 'Cerca'}
      </button>

      {errore && <p style={{ color: 'red' }}>{errore}</p>}

      <div style={{ marginTop: 20 }}>
        <pre>{risultati ? JSON.stringify(risultati, null, 2) : 'Nessun risultato'}</pre>
      </div>
    </div>
  );
}
