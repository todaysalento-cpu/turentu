'use client';

import { useReducer, useState, useRef, useEffect } from "react";
import { FaCar, FaMapMarkerAlt, FaCalendarAlt } from "react-icons/fa";
import RisultatiSlot from "../components/RisultatiSlot";
import BottomSheetCalendario from "../components/BottomSheetCalendario";
import { Calendar } from 'react-calendar';
import 'react-calendar/dist/Calendar.css';
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
  servizi?: string[]; // "libero" o "prenotabile"
}

type FormAction =
  | { type: "SET_ORIGINE"; payload: string }
  | { type: "SET_DESTINAZIONE"; payload: string }
  | { type: "SET_DATETIME"; payload: string }
  | { type: "SET_POSTI"; payload: number };

type FiltroSlot = "Tutte" | "Liberi" | "Prenotabili";

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

const formatReadableDate = (iso: string) => {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" }) +
    " - " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
};

// ---------------- Tab Component ----------------
interface TabsProps {
  filtri: FiltroSlot[];
  selected: FiltroSlot;
  onSelect: (filtro: FiltroSlot) => void;
}

function Tabs({ filtri, selected, onSelect }: TabsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto py-2 px-2">
      {filtri.map(f => (
        <button
          key={f}
          onClick={() => onSelect(f)}
          className={`flex-shrink-0 px-4 py-2 rounded ${
            f === selected ? "bg-[#ff3036] text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          } transition`}
        >
          {f}
        </button>
      ))}
    </div>
  );
}

// ---------------- Filtro dei risultati ----------------
const filtraRisultatiSlot = (risultati: Risultato[], filtro: FiltroSlot) => {
  if (filtro === "Tutte") return risultati;
  return risultati.filter(r => {
    if (!r.servizi) return false;
    if (filtro === "Liberi") return r.stato.includes("libero");
    if (filtro === "Prenotabili") return r.stato.includes("prenotabile");
    return true;
  });
};

// ---------------- HeaderMobile fisso esterno ----------------
import { FaArrowLeft } from "react-icons/fa";

function HeaderMobile({
  view,
  onEditSearch,
  filtroSlot,
  setFiltroSlot
}: {
  view: "form" | "results";
  onEditSearch: () => void;
  filtroSlot: FiltroSlot;
  setFiltroSlot: (f: FiltroSlot) => void;
}) {
  if (view !== "results") return null;

  return (
    <div className="fixed top-0 left-0 w-full z-50 bg-white border-b border-gray-200 flex items-center justify-between h-16 px-4">
      
      {/* Freccia a sinistra */}
      <button onClick={onEditSearch} className="text-2xl text-gray-700">
        <FaArrowLeft />
      </button>

      {/* Tabs centrali */}
      <div className="flex gap-4 mx-auto">
        <Tabs
          filtri={["Liberi", "Prenotabili"]}
          selected={filtroSlot}
          onSelect={setFiltroSlot}
        />
      </div>

      {/* Spazio vuoto a destra per bilanciare la freccia */}
      <div className="w-8" />
    </div>
  );
}

// ---------------- RicercaPage ----------------
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

  const [isMobile, setIsMobile] = useState<boolean>(typeof window !== "undefined" ? window.innerWidth < 768 : true);
  const [mobileView, setMobileView] = useState<"form" | "results">("form");

  const [filtroSlot, setFiltroSlot] = useState<FiltroSlot>("Tutte");

  const calendarRef = useRef<HTMLDivElement>(null);

  const risultatiFiltrati = filtraRisultatiSlot(risultati, filtroSlot);

  // Listener resize
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setMobileView("form"); // desktop: mostra sempre form + risultati
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleSubmit = async (e?: any) => {
    e?.preventDefault();
    setLoading(true);
    setRisultati([]);

    if (isMobile) setMobileView("results");

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

  // Click outside desktop calendar
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

      {/* ---------- MOBILE ---------- */}
      {isMobile ? (
        <>
          {/* Header fisso esterno */}
          <HeaderMobile
            view={mobileView}
            onEditSearch={() => setMobileView("form")}
            filtroSlot={filtroSlot}
            setFiltroSlot={setFiltroSlot}
          />

          {mobileView === "form" ? (
            <div className="flex flex-col gap-3">
              <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                {/* Origine */}
                <div className="relative h-[64px]">
                  <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
                  <input
                    value={form.localitaOrigine}
                    onChange={e => dispatch({ type: "SET_ORIGINE", payload: e.target.value })}
                    placeholder="Da dove parti?"
                    className="w-full h-full pl-10 pr-2 rounded border border-gray-300 focus:border-[#ff3036] py-4 text-base"
                  />
                </div>

                {/* Destinazione */}
                <div className="relative h-[64px]">
                  <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
                  <input
                    value={form.localitaDestinazione}
                    onChange={e => dispatch({ type: "SET_DESTINAZIONE", payload: e.target.value })}
                    placeholder="Dove vai?"
                    className="w-full h-full pl-10 pr-2 rounded border border-gray-300 focus:border-[#ff3036] py-4 text-base"
                  />
                </div>

                {/* Data/Ora */}
                <div className="relative h-[64px]">
                  <FaCalendarAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
                  <input
                    className="w-full h-full pl-10 pr-2 rounded border border-gray-300 cursor-pointer py-4 text-base"
                    readOnly
                    value={formatReadableDate(form.start_datetime)}
                    onClick={() => setCalendarOpen(true)}
                  />
                </div>

                {/* Posti */}
                <div className="h-[64px]">
                  <PostiSelector
                    value={form.posti_richiesti}
                    onChange={(value) => dispatch({ type: "SET_POSTI", payload: value })}
                  />
                </div>

                {/* Pulsante Cerca Mobile */}
                <MobileSearchCta onClick={handleSubmit} loading={loading} />
              </form>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto pt-[30px]">
  <RisultatiSlot risultati={risultatiFiltrati} />
</div>

          )}
        </>
      ) : (
        /* ---------- DESKTOP ---------- */
        <div className="flex flex-col gap-4 max-w-[1280px] mx-auto">
          <form onSubmit={handleSubmit} className="flex gap-3 items-end">
            {/* Origine */}
            <div className="relative flex-1 h-[52px]">
              <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                value={form.localitaOrigine}
                onChange={e => dispatch({ type: "SET_ORIGINE", payload: e.target.value })}
                placeholder="Da dove parti?"
                className="w-full h-full pl-10 pr-2 rounded border border-gray-300 focus:border-[#ff3036] py-2 text-sm"
              />
            </div>

            {/* Destinazione */}
            <div className="relative flex-1 h-[52px]">
              <FaMapMarkerAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                value={form.localitaDestinazione}
                onChange={e => dispatch({ type: "SET_DESTINAZIONE", payload: e.target.value })}
                placeholder="Dove vai?"
                className="w-full h-full pl-10 pr-2 rounded border border-gray-300 focus:border-[#ff3036] py-2 text-sm"
              />
            </div>

            {/* Data/Ora */}
            <div className="relative flex-1 h-[52px]">
              <FaCalendarAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                className="w-full h-full pl-10 pr-2 rounded border border-gray-300 cursor-pointer py-2 text-sm"
                readOnly
                value={formatReadableDate(form.start_datetime)}
                onClick={() => setDesktopCalendarOpen(!desktopCalendarOpen)}
              />
            </div>

            {/* Posti */}
            <div className="flex-shrink-0 h-[52px]">
              <PostiSelector
                value={form.posti_richiesti}
                onChange={(value) => dispatch({ type: "SET_POSTI", payload: value })}
              />
            </div>

            {/* Submit Desktop */}
            <div className="flex-shrink-0">
              <button
                type="submit"
                disabled={loading}
                className="h-[52px] bg-[#ff3036] text-white rounded px-4 flex items-center justify-center gap-2 hover:bg-red-600 transition-colors"
              >
                <FaCar />
                {loading ? "Cerco..." : "Cerca"}
              </button>
            </div>
          </form>

          {/* Tabs filtro */}
          <Tabs filtri={["Tutte","Liberi","Prenotabili"]} selected={filtroSlot} onSelect={setFiltroSlot} />

          {/* Risultati desktop */}
          <div>
            <RisultatiSlot risultati={risultatiFiltrati} />
          </div>
        </div>
      )}

      {/* ---------- CALENDARIO MOBILE ---------- */}
      {calendarOpen && (
        <BottomSheetCalendario
          value={form.start_datetime}
          onClose={() => setCalendarOpen(false)}
          onConfirm={(iso) => { dispatch({ type:"SET_DATETIME", payload:iso }); setCalendarOpen(false); }}
        />
      )}

      {/* ---------- CALENDARIO DESKTOP ---------- */}
      {desktopCalendarOpen && (
        <div ref={calendarRef} className="absolute z-50 mt-12 hidden md:block">
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
  );
}
