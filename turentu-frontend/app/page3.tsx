'use client';
import { useReducer, useState } from "react";
import { FaPlus, FaMinus, FaCar, FaMapMarkerAlt, FaUser, FaCalendarAlt } from "react-icons/fa";
import RisultatiSlot from "../components/RisultatiSlot";
import BottomSheetCalendario from "../components/BottomSheetCalendario";

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
  return d.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" }) 
         + " - " 
         + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

  const handleSubmit = async (e: any) => {
    e.preventDefault();
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
    <div className="w-full min-h-screen md:flex">
      {/* Colonna form + risultati */}
      <div className="w-full md:w-[420px] bg-white md:border-r md:border-gray-200 md:shadow z-10 flex justify-center">
        <div className="w-full max-w-[390px] md:max-w-none p-5 flex flex-col gap-4">
          
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {/* ORIGINE */}
            <div className="relative">
              <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                value={form.localitaOrigine}
                onChange={e => dispatch({type:"SET_ORIGINE", payload:e.target.value})}
                placeholder="Da dove parti?"
                className="w-full pl-8 h-10 rounded border border-gray-300 focus:border-[#ff3036]"
              />
            </div>

            {/* DESTINAZIONE */}
            <div className="relative">
              <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                value={form.localitaDestinazione}
                onChange={e => dispatch({type:"SET_DESTINAZIONE", payload:e.target.value})}
                placeholder="Dove vai?"
                className="w-full pl-8 h-10 rounded border border-gray-300 focus:border-[#ff3036]"
              />
            </div>

            {/* DATA/ORA */}
            <div className="relative">
              <FaCalendarAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                value={formatReadableDate(form.start_datetime)}
                readOnly
                placeholder="Seleziona data/ora"
                onClick={() => setCalendarOpen(true)}
                className="w-full h-10 pl-8 rounded border border-gray-300 cursor-pointer focus:border-[#ff3036]"
              />
            </div>

            {/* POSTI / PASSEGGERI */}
<div className="flex items-center h-10 bg-gray-100 rounded px-2 gap-2">
  {/* Pulsante decremento */}
  <button
    type="button"
    onClick={() => dispatch({ type: "DECREMENT_POSTI" })}
    className="flex-none inline-flex w-6 h-6 items-center justify-center rounded-full bg-[#ff3036] text-white hover:bg-red-600 text-sm"
  >
    -
  </button>

  {/* Icona + scritta */}
  <div className="flex-1 flex items-center justify-center gap-1">
    <FaUser className="text-[#ff3036]" />
    <span className="text-sm text-gray-700">
      {form.posti_richiesti} {form.posti_richiesti === 1 ? "passeggero" : "passeggeri"}
    </span>
  </div>

  {/* Pulsante incremento */}
  <button
    type="button"
    onClick={() => dispatch({ type: "INCREMENT_POSTI" })}
    className="flex-none inline-flex w-6 h-6 items-center justify-center rounded-full bg-[#ff3036] text-white hover:bg-red-600 text-sm"
  >
    +
  </button>
</div>




            {/* SUBMIT */}
            <button 
              type="submit" 
              disabled={loading} 
              className="h-10 bg-[#ff3036] text-white rounded px-4 flex items-center justify-center gap-2"
            >
              <FaCar /> {loading ? "Cerco..." : "Cerca"}
            </button>
          </form>

          {/* RISULTATI */}
          <RisultatiSlot risultati={risultati} />
        </div>
      </div>

      {/* MAPPA DESKTOP */}
      <div className="hidden md:flex flex-1 bg-gray-100">
        {/* MAPPA */}
      </div>

      {/* CALENDARIO */}
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
