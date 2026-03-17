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
import BookingFlow from "../components/BookingFlow";

/* =======================
   TIPI
======================= */

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

export type FiltroSlot = "Tutte" | "Liberi" | "Prenotabili";

/* =======================
   REDUCER FORM
======================= */

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
  // ---------------- CLIENT MOUNTED ----------------
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null; // evita hydration mismatch

  // ---------------- FORM & STATE ----------------
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

  const [isMobile, setIsMobile] = useState(false);
  const [mobileView, setMobileView] = useState<"form" | "results">("form");

  const [filtroSlot, setFiltroSlot] = useState<FiltroSlot>("Tutte");
  const [selectedIdsMobile, setSelectedIdsMobile] = useState<string[]>([]);
  const [selectedIdsDesktop, setSelectedIdsDesktop] = useState<string[]>([]);

  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookingType, setBookingType] = useState<"prenota" | "richiedi">("prenota");
  const [bookingIds, setBookingIds] = useState<string[]>([]);

  const calendarRef = useRef<HTMLDivElement>(null);
  const risultatiFiltrati = filtraRisultatiSlot(risultati, filtroSlot);

  // ---------------- EFFECTS ----------------
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setMobileView("form");
    };
    handleResize(); // imposta isMobile al mount
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

  // ---------------- HANDLERS ----------------
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

  const handleEditSearch = () => {
    setMobileView("form");
  };

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

  // ---------------- RENDER ----------------
  return (
    <div className="w-full min-h-screen flex flex-col">
      {/* Tutta la logica mobile/desktop rimane invariata */}
      {/* ... (qui puoi inserire il resto del markup come già l’hai scritto) */}
    </div>
  );
}
