'use client';

import { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

const BASE_URL = 'http://localhost:3001'; // backend
const CLIENTE_EMAIL = 'mario.rossi@example.com';
const CLIENTE_PASSWORD = 'PasswordCliente123';

interface Slot {
  id: number;
  veicolo_id: number;
  start_datetime: string;
  durata: { seconds: number };
  posti_disponibili: number;
  prezzo: string;
}

interface Pending {
  id: number;
  stato: string;
  start_datetime: string;
  durata: any;
  prezzo: string;
}

export default function LiveBookingPage() {
  const [cookie, setCookie] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [loading, setLoading] = useState(false);

  // 🔑 LOGIN AUTOMATICO
  const login = async () => {
    setLoading(true);
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CLIENTE_EMAIL, password: CLIENTE_PASSWORD }),
      credentials: 'include',
    });
    if (!res.ok) throw new Error('Login fallito');
    console.log('✅ Login riuscito');
    const cookieHeader = res.headers.get('set-cookie');
    setCookie(cookieHeader);
    setLoading(false);
  };

  // 📡 SOCKET.IO
  const setupSocket = () => {
    const s = io(BASE_URL, { withCredentials: true });
    s.on('connect', () => console.log('✅ Socket connesso:', s.id));
    s.on('pending_update', (updatedPending: Pending) => {
      console.log('🔔 Pending aggiornato:', updatedPending);
      if (pending && updatedPending.id === pending.id) setPending(updatedPending);
    });
    setSocket(s);
  };

  // 📦 CARICA SLOT
  const loadSlots = async () => {
   const res = await fetch(`${BASE_URL}/slots`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    coord: { lat: 45.4642, lon: 9.19 },     // esempio, puoi usare coordinate dinamiche
    coordDest: { lat: 45.4700, lon: 9.20 },
    posti_richiesti: 1
  }),
});

    if (!res.ok) {
      console.error('Errore caricamento slot');
      return;
    }
    const data = await res.json();
    setSlots(data.slots || []);
  };

  // 💳 CREA PAYMENT INTENT / PENDING
  const createPending = async (slot: Slot) => {
    setLoading(true);
    const res = await fetch(`${BASE_URL}/booking/payment-intent`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Cookie: cookie || ''
      },
      body: JSON.stringify({
        type: 'prenota',
        prezzo: Number(slot.prezzo),
        slots: [slot],
      }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log('✅ Pending creato:', data.pending[0]);
      setPending(data.pending[0]);
    } else {
      console.error('❌ Errore creazione pending:', data);
    }
    setLoading(false);
  };

  // 🚦 SIMULA ACCETTAZIONE PENDING AUTISTA
  const acceptPendingAsDriver = async () => {
    if (!pending) return;
    setLoading(true);
    const res = await fetch(`${BASE_URL}/pending/${pending.id}/accetta`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Cookie: cookie || ''
      },
    });
    const data = await res.json();
    if (res.ok) {
      console.log('✅ Pending accettato dal driver:', data);
      setPending({ ...pending, stato: 'accettata' });
    } else {
      console.error('❌ Errore accetta pending:', data);
    }
    setLoading(false);
  };

  useEffect(() => {
    login()
      .then(() => {
        loadSlots();
        setupSocket();
      })
      .catch(console.error);

    return () => {
      if (socket) socket.disconnect();
    };
  }, [cookie]);

  return (
    <div style={{ padding: '2rem', fontFamily: 'Arial' }}>
      <h1>📅 Live Booking Test</h1>

      {loading && <p style={{ color: 'blue' }}>⏳ Caricamento in corso...</p>}

      <h2>1️⃣ Seleziona Slot</h2>
      {slots.length === 0 && <p>Nessuno slot disponibile</p>}
      <ul>
        {slots.map((slot) => (
          <li key={slot.id} style={{ marginBottom: '0.5rem' }}>
            <button
              disabled={loading}
              onClick={() => {
                setSelectedSlot(slot);
                createPending(slot);
              }}
            >
              Slot {slot.id} | {new Date(slot.start_datetime).toLocaleTimeString()} | {slot.prezzo}€
            </button>
          </li>
        ))}
      </ul>

      {selectedSlot && pending && (
        <div style={{ marginTop: '2rem' }}>
          <h2>2️⃣ Pending creato</h2>
          <p>ID: {pending.id}</p>
          <p>Stato: {pending.stato}</p>
          <p>Prezzo: {pending.prezzo}€</p>
          <p>Durata: {JSON.stringify(pending.durata)}</p>

          <button
            style={{ marginTop: '1rem', backgroundColor: 'green', color: 'white', padding: '0.5rem 1rem' }}
            onClick={acceptPendingAsDriver}
            disabled={loading || pending.stato === 'accettata'}
          >
            ✅ Simula accetta pending (autista)
          </button>
        </div>
      )}

      {pending && (
        <div style={{ marginTop: '2rem', color: 'green' }}>
          <h2>🔔 Aggiornamenti live</h2>
          <p>Stato corrente: {pending.stato}</p>
        </div>
      )}
    </div>
  );
}
