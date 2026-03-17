'use client';

import { useReducer, useState, useRef, useEffect } from "react";
import { FaCalendarAlt } from "react-icons/fa";
import { Calendar } from "react-calendar";
import 'react-calendar/dist/Calendar.css';

import GoogleMapsLoader from "./GoogleMapsLoader";
import PostiSelector from "../components/PostiSelector";
import MobileSearchCta from "../components/MobileSearchCTA";
import HeaderMobile from "../components/HeaderMobile";
import Tabs from "../components/Tabs";
import RisultatiList from "../components/RisultatiList";
import ActionButton from "../components/ActionButton";
import BottomSheetCalendario from "../components/BottomSheetCalendario";
import LocationInput from "../components/LocationInput";
import BookingFlow from "../components/BookingFlow";

import { useUser } from "../context/UserContext";

/* =======================
   TIPI
======================= */
export interface RicercaForm {
  localitaOrigine: { nome: string; coord: { lat: number; lon: number } } | null;
  localitaDestinazione: { nome: string; coord: { lat: number; lon: number } } | null;
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

export type FiltroSlot = "Tutte" | "Liberi" | "Prenotabili";

/* =======================
   REDUCER FORM
======================= */
type FormAction =
  | { type: "SET_ORIGINE"; payload: { nome: string; coord: { lat: number; lon: number } } }
  | { type: "SET_DESTINAZIONE"; payload: { nome: string; coord: { lat: number; lon: number } } }
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

/* =======================
   UTILS
======================= */
const nowISO = () => new Date().toISOString().slice(0, 16);

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
  return risultati.filter(r =>
    r.stato?.includes(filtro === "Liberi" ? "libero" : "prenotabile")
  );
};

/* =======================
   PAGE
======================= */
export default function RicercaPage() {
  const { user } = useUser();

  const [form, dispatch] = useReducer(formReducer, {
    localitaOrigine: null,
    localitaDestinazione: null,
    start_datetime: nowISO(),
    posti_richiesti: 1
  });

  const [risultati, setRisultati] = useState<Risultato[]>([]);
  const [loading, setLoading] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [desktopCalendarOpen, setDesktopCalendarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(true);
  const [mobileView, setMobileView] = useState<"form" | "results">("form");
  const [filtroSlot, setFiltroSlot] = useState<FiltroSlot>("Tutte");
  const [selectedIdsMobile, setSelectedIdsMobile] = useState<string[]>([]);
  const [selectedIdsDesktop, setSelectedIdsDesktop] = useState<string[]>([]);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookingType, setBookingType] = useState<"prenota" | "richiedi">("prenota");
  const [bookingIds, setBookingIds] = useState<string[]>([]);

  const calendarRef = useRef<HTMLDivElement>(null);
  const risultatiFiltrati = filtraRisultatiSlot(risultati, filtroSlot);

  /* =======================
     EFFECTS
  ======================== */
  useEffect(() => {
    setIsMobile(window.innerWidth < 768);
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    setSelectedIdsMobile([]);
    setSelectedIdsDesktop([]);
  }, [filtroSlot]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(event.target as Node)) {
        setDesktopCalendarOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  /* =======================
     HANDLERS
  ======================== */
  const handleSubmit = async () => {
    if (!form.localitaOrigine || !form.localitaDestinazione) {
      alert("Seleziona sia origine che destinazione con la mappa!");
      return;
    }

    setLoading(true);
    setRisultati([]);
    if (isMobile) setMobileView("results");

    try {
      const bodyToSend = {
        localitaOrigine: form.localitaOrigine?.nome || "",
        coord: form.localitaOrigine?.coord || { lat: 0, lon: 0 },
        localitaDestinazione: form.localitaDestinazione?.nome || "",
        coordDest: form.localitaDestinazione?.coord || { lat: 0, lon: 0 },
        start_datetime: form.start_datetime,
        posti_richiesti: form.posti_richiesti,
      };

      const res = await fetch("http://localhost:3001/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyToSend),
      });

      const data = await res.json();
      setRisultati(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Errore fetch search:", err);
      setRisultati([]);
    } finally {
      setLoading(false);
    }
  };

  const handleEditSearch = () => setMobileView("form");

  const openBookingFlow = (ids: string[]) => {
    setBookingType(filtroSlot === "Liberi" ? "richiedi" : "prenota");
    setBookingIds(ids);
    setBookingOpen(true);
  };

  const handleSelectMobile = (id: string) => {
    if (filtroSlot === "Liberi") {
      setSelectedIdsMobile(prev =>
        prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      );
    } else {
      setSelectedIdsMobile([id]);
    }
  };

  const handleSelectDesktop = (id: string) => {
    if (filtroSlot === "Liberi") {
      setSelectedIdsDesktop(prev =>
        prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      );
    } else {
      setSelectedIdsDesktop([id]);
    }
  };

  const risultatiSelezionati = risultati.filter(r => bookingIds.includes(r.id));

  /* =======================
     RENDER
  ======================== */
  return (
    <div className="w-full min-h-screen flex flex-col">
      <GoogleMapsLoader />

{/* ---------------- MOBILE ---------------- */}
{isMobile && (
  <>
    {!bookingOpen && mobileView === "results" && (
      <HeaderMobile
        filtroSlot={filtroSlot}
        setFiltroSlot={setFiltroSlot}
        hideTabs={bookingOpen}
        onEditSearch={handleEditSearch}
      />
    )}

    {mobileView === "form" ? (
      <div className="flex flex-col gap-4 p-4 mt-16">
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

        <div className="relative h-[48px]">
          <FaCalendarAlt className="absolute left-3 top-1/2 -translate-y-1/2 text-[#ff3036]" />
          <input
            readOnly
            value={formatReadableDate(form.start_datetime)}
            onClick={() => setCalendarOpen(true)}
            className="w-full h-full pl-10 pr-3 rounded-xl border border-gray-300 
                       focus:border-[#ff3036] focus:ring-2 focus:ring-[#ff3036]/20 
                       transition text-sm"
          />
        </div>

        <PostiSelector
          value={form.posti_richiesti}
          onChange={(v) => dispatch({ type: "SET_POSTI", payload: v })}
        />

        <div className="pt-2">
          <MobileSearchCta onClick={handleSubmit} loading={loading} />
        </div>
      </div>
    ) : (
      <div className="flex-1 relative mt-16 bg-white">
        {/* Risultati FULL WIDTH */}
        <div className="overflow-y-auto pb-28 pt-2">
          <RisultatiList
            risultati={risultatiFiltrati}
            filtroSlot={filtroSlot}
            selectedIds={selectedIdsMobile}
            onSelect={handleSelectMobile}
          />
        </div>

        {/* Bottom action */}
        {selectedIdsMobile.length > 0 && (
          <div className="fixed bottom-0 left-0 w-full px-4 py-4 
                          bg-white border-t border-gray-200 z-50">
            <ActionButton
              filtroSlot={filtroSlot}
              selectedIds={selectedIdsMobile}
              onAction={openBookingFlow}
            />
          </div>
        )}
      </div>
    )}
  </>
)}

      {/* ---------------- DESKTOP ---------------- */}
      {!isMobile && (
        <div className="flex flex-col gap-4 max-w-[1280px] mx-auto p-4">
          <form className="flex flex-col md:flex-row md:items-end gap-3" onSubmit={(e) => e.preventDefault()}>
            <LocationInput
              label="Da dove parti?"
              value={form.localitaOrigine}
              onSelect={(val) => dispatch({ type: "SET_ORIGINE", payload: val })}
              className="flex-1"
            />
            <LocationInput
              label="Dove vai?"
              value={form.localitaDestinazione}
              onSelect={(val) => dispatch({ type: "SET_DESTINAZIONE", payload: val })}
              className="flex-1"
            />

            <div className="relative w-full md:w-auto flex-1">
              <FaCalendarAlt className="absolute left-3 top-1/2 -translate-y-1/2 text-[#ff3036]" />
              <input
                readOnly
                value={formatReadableDate(form.start_datetime)}
                onClick={() => setDesktopCalendarOpen(true)}
                className="w-full h-[50px] pl-10 pr-3 rounded-lg border border-gray-300 focus:border-[#ff3036] focus:ring-1 focus:ring-[#ff3036] transition"
              />
            </div>

            <PostiSelector
              value={form.posti_richiesti}
              onChange={(v) => dispatch({ type: "SET_POSTI", payload: v })}
            />

            <button
              type="button"
              onClick={handleSubmit}
              className="h-[50px] bg-[#ff3036] text-white px-6 rounded-lg font-semibold hover:bg-[#e32b2f] transition"
            >
              {loading ? "Caricamento..." : "Cerca"}
            </button>
          </form>

          {risultati.length > 0 && (
            <Tabs filtri={["Liberi", "Prenotabili"]} selected={filtroSlot} onSelect={setFiltroSlot} />
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
                  onAction={openBookingFlow}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------------- CALENDARI ---------------- */}
      {calendarOpen && (
        <BottomSheetCalendario
          value={form.start_datetime}
          onClose={() => setCalendarOpen(false)}
          onConfirm={(iso) => dispatch({ type: "SET_DATETIME", payload: iso })}
        />
      )}

      {desktopCalendarOpen && (
        <div ref={calendarRef} className="absolute z-50 mt-12 hidden md:block">
          <Calendar
            value={new Date(form.start_datetime)}
            onChange={(date: Date) => {
              dispatch({ type: "SET_DATETIME", payload: date.toISOString().slice(0, 16) });
              setDesktopCalendarOpen(false);
            }}
          />
        </div>
      )}

      {/* ---------------- BOOKING FLOW ---------------- */}
      {bookingOpen && risultatiSelezionati.length > 0 && user ? (
        <BookingFlow
          open={bookingOpen}
          type={bookingType}
          risultatiSelezionati={risultatiSelezionati}
          onClose={() => setBookingOpen(false)}
          localitaOrigine={form.localitaOrigine?.nome || ""}
          localitaDestinazione={form.localitaDestinazione?.nome || ""}
          datetime={form.start_datetime}
          posti={form.posti_richiesti}
          clienteId={user.id}
          coordOrigine={form.localitaOrigine?.coord}
          coordDestinazione={form.localitaDestinazione?.coord}
        />
      ) : bookingOpen && risultatiSelezionati.length > 0 ? (
        <p className="text-center py-4 text-red-600">Caricamento dati utente...</p>
      ) : null}
    </div>
  );
}
