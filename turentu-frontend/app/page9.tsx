'use client';

import { useReducer, useState, useRef, useEffect } from "react";
import { FaPlus, FaMinus, FaCar, FaMapMarkerAlt, FaUser, FaCalendarAlt } from "react-icons/fa";
import RisultatiSlot from "../components/RisultatiSlot";
import BottomSheetCalendario from "../components/BottomSheetCalendario";
import { Calendar } from 'react-calendar';
import 'react-calendar/dist/Calendar.css'; // Assicurati di aver installato react-calendar
import PostiSelector from "../components/PostiSelector";
import MobileSearchCta from "../components/MobileSearchCTA";

interface RicercaForm {
  localitaOrigine: string;
  localitaDestinazione: string;
  start_datetime: string;
  posti_richiesti: number;
}

interface Risultato {
  id: string;
  oraPartenza: string;
  oraArrivo: string;
  localitaOrigine: string;
  localitaDestinazione: string;
  durataMs?: number;
  prezzo?: number;
  modello: string;
  servizi?: string[];
}

type FormAction =
  | { type: "SET_ORIGINE"; payload: string }
  | { type: "SET_DESTINAZIONE"; payload: string }
  | { type: "SET_DATETIME"; payload: string }
  | { type: "INCREMENT_POSTI" }
  | { type: "DECREMENT_POSTI" };

const formReducer = (state: RicercaForm, action: FormAction): RicercaForm => {
  switch (action.type) {
    case "SET_ORIGINE": return { ...state, localitaOrigine: action.payload };
    case "SET_DESTINAZIONE": return { ...state, localitaDestinazione: action.payload };
    case "SET_DATETIME": return { ...state, start_datetime: action.payload };
    case "INCREMENT_POSTI": return { ...state, posti_richiesti: state.posti_richiesti + 1 };
    case "DECREMENT_POSTI": return { ...state, posti_richiesti: Math.max(1, state.posti_richiesti - 1) };
    default: return state;
  }
};

const nowISO = () => new Date().toISOString().slice(0,16);

const formatReadableDate = (iso: string) => {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" }) +
    " - " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
};

export default function RicercaPage() {
  const [form, dispatch] = useReducer(formReducer, { 
    localitaOrigine: "", 
    localitaDestinazione: "", 
    start_datetime: nowISO(), 
    posti_richiesti: 1 
  });

  const [risultati, setRisultati] = useState<Risultato[]>([]);
  const [loading, setLoading] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [desktopCalendarOpen, setDesktopCalendarOpen] = useState(false);
  const calendarRef = useRef<HTMLDivElement>(null);

  const handleSubmit = async (e?: any) => {
    e?.preventDefault();
    setLoading(true);
    setRisultati([]);
    try {
      const res = await fetch("http://localhost:3001/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      setRisultati(Array.isArray(data) ? data : []);
    } catch {
      setRisultati([]);
    } finally {
      setLoading(false);
    }
  };

  // Chiudi calendario desktop se click fuori
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(event.target as Node)) {
        setDesktopCalendarOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="w-full min-h-screen p-4 flex flex-col gap-4">

      {/* ---------- FORM ----------- */}
      <form className="w-full max-w-[1280px] mx-auto p-0  flex flex-col md:flex-row gap-2 items-stretch">
{/* Origine */}
        <div className="relative flex-1 min-w-0 h-13">
          <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
          <input
            value={form.localitaOrigine}
            onChange={e => dispatch({ type: "SET_ORIGINE", payload: e.target.value })}
            placeholder="Da dove parti?"
            className="w-full h-13 pl-8 rounded border border-gray-300 focus:border-[#ff3036]"
          />
        </div>

        {/* Destinazione */}
        <div className="relative flex-1 min-w-0 h-13">
          <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
          <input
            value={form.localitaDestinazione}
            onChange={e => dispatch({ type: "SET_DESTINAZIONE", payload: e.target.value })}
            placeholder="Dove vai?"
            className="w-full h-13 pl-8 rounded border border-gray-300 focus:border-[#ff3036]"
          />
        </div>

        {/* Data/Ora */}
        <div className="relative flex-1 min-w-0 h-13">
          <FaCalendarAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
          {/* Mobile */}
          <input
            className="w-full h-13 pl-8 rounded border border-gray-300 cursor-pointer md:hidden"
            readOnly
            value={formatReadableDate(form.start_datetime)}
            onClick={() => setCalendarOpen(true)}
          />
          {/* Desktop */}
          <input
            className="w-full h-13 pl-8 rounded border border-gray-300 hidden md:block cursor-pointer"
            readOnly
            value={formatReadableDate(form.start_datetime)}
            onClick={() => setDesktopCalendarOpen(!desktopCalendarOpen)}
          />
          {desktopCalendarOpen && (
            <div ref={calendarRef} className="absolute z-50 mt-12">
              <Calendar
                value={new Date(form.start_datetime)}
                onChange={(date: Date) => {
                  dispatch({ type: "SET_DATETIME", payload: date.toISOString().slice(0,16) });
                  setDesktopCalendarOpen(false);
                }}
              />
            </div>
          )}
        </div>

     
       {/* Selettore Posti */}
<PostiSelector
  value={form.posti_richiesti} // prima era "posti"
  onChange={(value) => dispatch({ type: "SET_POSTI", payload: value })} // prima era "setPosti"
/>

{/* Submit DESKTOP */}
<div className="hidden md:flex items-end">
  <button
    type="submit"
    disabled={loading}
    className="h-13 bg-[#ff3036] text-white rounded px-4 flex items-center justify-center gap-2 hover:bg-red-600 transition-colors"
  >
    <FaCar />
    {loading ? "Cerco..." : "Cerca"}
  </button>
</div>

      </form>

{/* ---------- MOBILE SEARCH CTA ---------- */}
<MobileSearchCta
  onClick={handleSubmit}
  loading={loading}
/>

      {/* ---------- RISULTATI ---------- */}
      <div className="w-full max-w-[1280px] mx-auto p-0">
        <RisultatiSlot risultati={risultati} />
      </div>

      {/* ---------- CALENDARIO MOBILE ---------- */}
      {calendarOpen && (
        <BottomSheetCalendario
          value={form.start_datetime}
          onClose={() => setCalendarOpen(false)}
          onConfirm={(iso) => { dispatch({type:"SET_DATETIME", payload:iso}); setCalendarOpen(false); }}
        />
      )}
    </div>
  );
}
