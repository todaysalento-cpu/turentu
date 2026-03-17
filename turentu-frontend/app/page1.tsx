'use client';

import { useReducer, useState } from "react";
import { FaCar, FaMapMarkerAlt } from "react-icons/fa";
import RisultatiSlot from "../components/RisultatiSlot";
import BottomSheetCalendario from "../components/BottomSheetCalendario";

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
  | { type: "INCREMENT_POSTI" }
  | { type: "DECREMENT_POSTI" };

const formReducer = (state: RicercaForm, action: FormAction): RicercaForm => {
  switch (action.type) {
    case "SET_ORIGINE":
      return { ...state, localitaOrigine: action.payload };
    case "SET_DESTINAZIONE":
      return { ...state, localitaDestinazione: action.payload };
    case "SET_DATETIME":
      return { ...state, start_datetime: action.payload };
    case "INCREMENT_POSTI":
      return { ...state, posti_richiesti: state.posti_richiesti + 1 };
    case "DECREMENT_POSTI":
      return { ...state, posti_richiesti: Math.max(1, state.posti_richiesti - 1) };
    default:
      return state;
  }
};

const nowISO = () => new Date().toISOString().slice(0, 16);

export default function HomePage() {
  const [form, dispatch] = useReducer(formReducer, {
    localitaOrigine: "",
    localitaDestinazione: "",
    start_datetime: nowISO(),
    posti_richiesti: 1
  });

  const [risultati, setRisultati] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setRisultati([]);

    try {
      const res = await fetch("http://localhost:3001/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("Fetch error:", text);
        setRisultati([]);
        return;
      }

      const data = await res.json();
      setRisultati(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setRisultati([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full min-h-screen md:flex">
      {/* SIDEBAR RICERCA */}
      <div className="w-full md:w-[420px] bg-white md:border-r md:border-gray-200 md:shadow z-10 flex justify-center">
        <div className="w-full max-w-[390px] p-5 flex flex-col gap-4">

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {/* ORIGINE */}
            <div className="relative">
              <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                value={form.localitaOrigine}
                onChange={e => dispatch({ type: "SET_ORIGINE", payload: e.target.value })}
                placeholder="Da dove parti?"
                className="w-full pl-8 h-10 rounded border border-gray-300 focus:border-[#ff3036]"
              />
            </div>

            {/* DESTINAZIONE */}
            <div className="relative">
              <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                value={form.localitaDestinazione}
                onChange={e => dispatch({ type: "SET_DESTINAZIONE", payload: e.target.value })}
                placeholder="Dove vai?"
                className="w-full pl-8 h-10 rounded border border-gray-300 focus:border-[#ff3036]"
              />
            </div>

            {/* POSTI + CERCA */}
            <div className="flex gap-2">
              <div className="flex items-center bg-gray-100 rounded">
                <button type="button" onClick={() => dispatch({ type: "DECREMENT_POSTI" })} className="px-3">-</button>
                <span className="px-2">{form.posti_richiesti}</span>
                <button type="button" onClick={() => dispatch({ type: "INCREMENT_POSTI" })} className="px-3">+</button>
              </div>

<button
  type="submit"
  disabled={loading}
  className="flex-1 h-10 bg-[#ff3036] text-white rounded flex items-center justify-center gap-2"
>
  <FaCar />
  {loading ? "Cerco..." : "Cerca"}
</button>

