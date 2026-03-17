'use client';

import { useReducer, useState } from "react";
import { FaCar, FaMapMarkerAlt, FaCalendarAlt } from "react-icons/fa";
import RisultatiSlot from "../components/RisultatiSlot";
import BottomSheetCalendario from "../components/BottomSheetCalendario";
import PostiSelector from "../components/PostiSelector";
import DesktopCalendar from "../components/CalendarioDesktop";
import MobileSearchCta from "../components/MobileSearchCTA";

interface RicercaForm {
  localitaOrigine: string;
  localitaDestinazione: string;
  start_datetime: string;
  posti_richiesti: number;
}

type FormAction =
  | { type: "SET_ORIGINE"; payload: string }
  | { type: "SET_DESTINAZIONE"; payload: string }
  | { type: "SET_DATETIME"; payload: string }
  | { type: "SET_POSTI"; payload: number };

const formReducer = (state: RicercaForm, action: FormAction): RicercaForm => {
  switch (action.type) {
    case "SET_ORIGINE": return { ...state, localitaOrigine: action.payload };
    case "SET_DESTINAZIONE": return { ...state, localitaDestinazione: action.payload };
    case "SET_DATETIME": return { ...state, start_datetime: action.payload };
    case "SET_POSTI": return { ...state, posti_richiesti: action.payload };
    default: return state;
  }
};

const nowISO = () => new Date().toISOString().slice(0,16);

export default function RicercaPage() {
  const [form, dispatch] = useReducer(formReducer, {
    localitaOrigine: "",
    localitaDestinazione: "",
    start_datetime: nowISO(),
    posti_richiesti: 1
  });

  const [risultati, setRisultati] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

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

  return (
    <div className="w-full min-h-screen p-4 flex flex-col gap-4">
      <form className="w-full max-w-[1280px] mx-auto flex flex-col md:flex-row gap-4 items-stretch">
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

{/* Calendario */}
<div className="relative flex-1 min-w-0 h-13">
  {/* Mobile */}
  <div
    className="relative md:hidden cursor-pointer"
    onClick={() => setCalendarOpen(true)}
  >
    <FaCalendarAlt className="absolute left-3 top-1/2 -translate-y-1/2 text-[#ff3036]" />

    <input
      className="w-full h-13 pl-8 rounded border border-gray-300 bg-white cursor-pointer"
      readOnly
      value={new Date(form.start_datetime).toLocaleString("it-IT", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}
    />
  </div>

  {/* Desktop */}
  <DesktopCalendar
    value={form.start_datetime}
    onChange={(iso) =>
      dispatch({ type: "SET_DATETIME", payload: iso })
    }
  />
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
<div className="w-full max-w-[1280px] mx-auto">
  <RisultatiSlot risultati={risultati} />
</div>

{/* ---------- CALENDARIO MOBILE ---------- */}
{calendarOpen && (
  <BottomSheetCalendario
    value={form.start_datetime}
    onClose={() => setCalendarOpen(false)}
    onConfirm={(iso) => {
      dispatch({ type: "SET_DATETIME", payload: iso });
      setCalendarOpen(false);
    }}
  />
)}
</div>
  );
}
