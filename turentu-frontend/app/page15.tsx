'use client';

import { useReducer, useState, useRef, useEffect } from "react";
import { FaCalendarAlt } from "react-icons/fa";
import { Calendar } from "react-calendar";
import 'react-calendar/dist/Calendar.css';

import PostiSelector from "../components/PostiSelector";
import MobileSearchCta from "../components/MobileSearchCTA";
import HeaderMobile from "../components/HeaderMobile";
import Tabs from "../components/Tabs";
import RisultatiList from "../components/RisultatiList";
import ActionButton from "../components/ActionButton";
import BottomSheetCalendario from "../components/BottomSheetCalendario";
import LocationInput from "../components/LocationInput";

export interface RicercaForm {
  localitaOrigine: string;
  localitaDestinazione: string;
  start_datetime: string;
  posti_richiesti: number;
}

export interface Risultato {
  id: string;
  oraPartenza: string;
  oraArrivo: string;
  localitaOrigine: string;
  localitaDestinazione: string;
  durataMs?: number;
  prezzo?: number;
  modello: string;
  servizi?: string[];
  stato?: string[];
}

type FormAction =
  | { type: "SET_ORIGINE"; payload: string }
  | { type: "SET_DESTINAZIONE"; payload: string }
  | { type: "SET_DATETIME"; payload: string }
  | { type: "SET_POSTI"; payload: number };

export type FiltroSlot = "Tutte" | "Liberi" | "Prenotabili";

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

const filtraRisultatiSlot = (risultati: Risultato[], filtro: FiltroSlot) => {
  if (filtro === "Tutte") return risultati;
  return risultati.filter(r => r.stato && r.stato.includes(filtro === "Liberi" ? "libero" : "prenotabile"));
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

  const [isMobile, setIsMobile] = useState<boolean>(typeof window !== "undefined" ? window.innerWidth < 768 : true);
  const [mobileView, setMobileView] = useState<"form" | "results">("form");

  const [filtroSlot, setFiltroSlot] = useState<FiltroSlot>("Tutte");
  const [selectedIdsMobile, setSelectedIdsMobile] = useState<string[]>([]);
  const [selectedIdsDesktop, setSelectedIdsDesktop] = useState<string[]>([]);

  const calendarRef = useRef<HTMLDivElement>(null);
  const risultatiFiltrati = filtraRisultatiSlot(risultati, filtroSlot);

  // Resize listener
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setMobileView("form");
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Reset selezioni quando filtro cambia
  useEffect(() => {
    setSelectedIdsMobile([]);
    setSelectedIdsDesktop([]);
  }, [filtroSlot]);

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

  const handleSubmit = async () => {
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

  const handleSelectMobile = (id: string) => {
    if (filtroSlot === "Liberi") setSelectedIdsMobile(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
    else if (filtroSlot === "Prenotabili") setSelectedIdsMobile([id]);
  };

  const handleSelectDesktop = (id: string) => {
    if (filtroSlot === "Liberi") setSelectedIdsDesktop(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
    else if (filtroSlot === "Prenotabili") setSelectedIdsDesktop([id]);
  };

  return (
    <div className="w-full min-h-screen flex flex-col">

      {/* MOBILE */}
      {isMobile ? (
        <>
          {mobileView === "results" && (
            <HeaderMobile
              view={mobileView}
              onEditSearch={() => setMobileView("form")}
              filtroSlot={filtroSlot}
              setFiltroSlot={setFiltroSlot}
            />
          )}

          {mobileView === "form" ? (
            <div className="flex flex-col gap-3 p-4">
              {/* Origine/Destinazione */}
              <LocationInput
                label="Da dove parti?"
                value={form.localitaOrigine}
                onSelect={(val) => dispatch({ type: "SET_ORIGINE", payload: val })}
              />
              <LocationInput
                label="Dove vai?"
                value={form.localitaDestinazione}
                onSelect={(val) => dispatch({ type: "SET_DESTINAZIONE", payload: val })}
              />

              {/* Data/Ora */}
              <div className="relative h-[64px]">
                <FaCalendarAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
                <input
                  readOnly
                  value={formatReadableDate(form.start_datetime)}
                  onClick={() => setCalendarOpen(true)}
                  className="w-full h-full pl-10 pr-2 rounded border border-gray-300 cursor-pointer py-4 text-base"
                />
              </div>

              {/* Posti */}
              <div className="h-[64px]">
                <PostiSelector
                  value={form.posti_richiesti}
                  onChange={(value) => dispatch({ type: "SET_POSTI", payload: value })}
                />
              </div>

              {/* Cerca */}
              <MobileSearchCta onClick={handleSubmit} loading={loading} />
            </div>
          ) : (
            <div className="flex-1 relative">
              <div className="overflow-y-auto pb-24 px-4 pt-4">
                <RisultatiList
                  risultati={risultatiFiltrati}
                  filtroSlot={filtroSlot}
                  selectedIds={selectedIdsMobile}
                  onSelect={handleSelectMobile}
                />
              </div>

              {selectedIdsMobile.length > 0 && (
                <div className="fixed bottom-0 left-0 w-full px-4 py-4 bg-white z-50">
                  <ActionButton
                    filtroSlot={filtroSlot}
                    selectedIds={selectedIdsMobile}
                    onAction={(ids) => console.log("Azione mobile:", ids)}
                  />
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        // DESKTOP
        <div className="flex flex-col gap-4 max-w-[1280px] mx-auto p-4">
          <form className="flex gap-3 items-end" onSubmit={(e) => e.preventDefault()}>
            <LocationInput
              label="Da dove parti?"
              value={form.localitaOrigine}
              onSelect={(val) => dispatch({ type: "SET_ORIGINE", payload: val })}
            />
            <LocationInput
              label="Dove vai?"
              value={form.localitaDestinazione}
              onSelect={(val) => dispatch({ type: "SET_DESTINAZIONE", payload: val })}
            />
            <div className="relative h-[64px]">
              <FaCalendarAlt className="absolute left-2 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                readOnly
                value={formatReadableDate(form.start_datetime)}
                onClick={() => setDesktopCalendarOpen(true)}
                className="w-full h-full pl-10 pr-2 rounded border border-gray-300 cursor-pointer py-4 text-base"
              />
            </div>
            <PostiSelector
              value={form.posti_richiesti}
              onChange={(value) => dispatch({ type: "SET_POSTI", payload: value })}
            />
            <button
              type="button"
              onClick={handleSubmit}
              className="bg-[#ff3036] text-white py-3 px-6 rounded-lg font-semibold"
            >
              {loading ? "Caricamento..." : "Cerca"}
            </button>
          </form>

          {risultati.length > 0 && (
            <Tabs filtri={["Liberi","Prenotabili"]} selected={filtroSlot} onSelect={setFiltroSlot} />
          )}

          <div className="relative">
            <div className="overflow-y-auto pb-24">
              <RisultatiList
                risultati={risultatiFiltrati}
                filtroSlot={filtroSlot}
                selectedIds={selectedIdsDesktop}
                onSelect={handleSelectDesktop}
              />
            </div>
            {selectedIdsDesktop.length > 0 && (
              <div className="fixed bottom-4 left-0 w-full px-4 z-50">
                <ActionButton
                  filtroSlot={filtroSlot}
                  selectedIds={selectedIdsDesktop}
                  onAction={(ids) => console.log("Azione desktop:", ids)}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Calendario Mobile */}
      {calendarOpen && (
        <BottomSheetCalendario
          value={form.start_datetime}
          onClose={() => setCalendarOpen(false)}
          onConfirm={(iso) => { dispatch({ type:"SET_DATETIME", payload:iso }); setCalendarOpen(false); }}
        />
      )}

      {/* Calendario Desktop */}
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
