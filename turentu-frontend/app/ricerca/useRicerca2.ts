'use client';
import { useReducer, useState, useEffect, useMemo } from "react";
import { useUser } from "../../context/UserContext";
import { RicercaForm, Risultato, FiltroSlot, Coord } from "./types";

/* ===================== REDUCER ===================== */
type FormAction =
  | { type: "SET_ORIGINE"; payload: { nome: string; coord: Coord } }
  | { type: "SET_DESTINAZIONE"; payload: { nome: string; coord: Coord } }
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

/* ===================== HOOK ===================== */
export function useRicerca() {
  const { user } = useUser();

  const [form, dispatch] = useReducer(formReducer, {
    localitaOrigine: null,
    localitaDestinazione: null,
    start_datetime: new Date().toISOString().slice(0,16),
    posti_richiesti: 1,
  });

  const [risultati, setRisultati] = useState<Risultato[]>([]);
  const [loading, setLoading] = useState(false);
  const [filtroSlot, setFiltroSlot] = useState<FiltroSlot>("Tutte");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookingType, setBookingType] = useState<"prenota" | "richiedi">("prenota");

  const [isMobile, setIsMobile] = useState(true);

  /* Rileva mobile */
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  /* Filtra risultati */
  const risultatiFiltrati = useMemo(() => {
    if(filtroSlot === "Tutte") return risultati;
    return risultati.filter(r =>
      r.stato?.includes(filtroSlot === "Liberi" ? "libero" : "prenotabile")
    );
  }, [risultati, filtroSlot]);

  /* Submit ricerca */
  const handleSubmit = async () => {
    if(!form.localitaOrigine || !form.localitaDestinazione){
      alert("Seleziona origine e destinazione!");
      return;
    }
    setLoading(true);
    setRisultati([]);

    try {
      const body = {
        localitaOrigine: form.localitaOrigine.nome,
        coord: form.localitaOrigine.coord,
        localitaDestinazione: form.localitaDestinazione.nome,
        coordDest: form.localitaDestinazione.coord,
        start_datetime: form.start_datetime,
        posti_richiesti: form.posti_richiesti
      };
      const res = await fetch("http://localhost:3001/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      setRisultati(Array.isArray(data) ? data : []);
    } catch(e) {
      console.error(e);
      setRisultati([]);
    } finally { setLoading(false); }
  };

  /* Booking */
  const openBookingFlow = (ids: string[]) => {
    setBookingType(filtroSlot === "Liberi" ? "richiedi" : "prenota");
    setSelectedIds(ids);
    setBookingOpen(true);
  };

  return {
    form,
    dispatch,
    risultatiFiltrati,
    loading,
    filtroSlot,
    setFiltroSlot,
    selectedIds,
    setSelectedIds,
    bookingOpen,
    setBookingOpen,
    bookingType,
    handleSubmit,
    openBookingFlow,
    isMobile,
    user
  };
}
