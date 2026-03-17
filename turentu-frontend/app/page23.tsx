'use client';

import { useReducer, useState, useEffect } from "react";
import SearchForm, { RicercaForm } from "../components/SearchForm";
import RisultatiSelection from "../components/RisultatiSelection";
import BookingFlow from "../components/BookingFlow";
import BookingCard from "../components/BookingCard";
import AppInput from "../components/ui/appInput";
import { useUser } from "../context/UserContext";

/* -------------------- TIPI -------------------- */
export type FiltroSlot = "Tutte" | "Liberi" | "Prenotabili";

/* -------------------- UTILS -------------------- */
const nowISO = () => new Date().toISOString().slice(0,16);

const formReducer = (state: RicercaForm, action: any): RicercaForm => {
  switch(action.type){
    case "SET_ORIGINE": return {...state, localitaOrigine: action.payload};
    case "SET_DESTINAZIONE": return {...state, localitaDestinazione: action.payload};
    case "SET_DATETIME": return {...state, start_datetime: action.payload};
    case "SET_POSTI": return {...state, posti_richiesti: action.payload};
    default: return state;
  }
}

/* -------------------- PAGE -------------------- */
export default function RicercaPage() {
  const { user } = useUser();

  /* Form & ricerca */
  const [form, dispatch] = useReducer(formReducer, {
    localitaOrigine: null,
    localitaDestinazione: null,
    start_datetime: nowISO(),
    posti_richiesti: 1
  });
  const [loading, setLoading] = useState(false);
  const [risultati, setRisultati] = useState<any[]>([]);

  /* Mobile/Desktop */
  const [isMobile, setIsMobile] = useState(true);

  /* Filtri e selezioni */
  const [filtroSlot, setFiltroSlot] = useState<FiltroSlot>("Tutte");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  /* Booking Flow */
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookingType, setBookingType] = useState<"prenota" | "richiedi">("prenota");
  const [bookingIds, setBookingIds] = useState<string[]>([]);

  /* ------------------- CARD INPUT ------------------- */
  const [cardOpen, setCardOpen] = useState(false);
  const [activeField, setActiveField] = useState<"origine" | "destinazione" | "datetime" | "posti" | null>(null);

  const openCard = (field: typeof activeField) => {
    setActiveField(field);
    setCardOpen(true);
  };

  const closeCard = () => {
    setActiveField(null);
    setCardOpen(false);
  };

  /* Responsiveness */
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  /* ===================== HANDLERS ===================== */
  const handleSubmit = async () => {
    if(!form.localitaOrigine || !form.localitaDestinazione){
      alert("Seleziona origine e destinazione");
      return;
    }

    setLoading(true);
    setSelectedIds([]);
    try {
      const bodyToSend = {
        localitaOrigine: form.localitaOrigine.nome,
        coordOrig: form.localitaOrigine.coord,
        localitaDestinazione: form.localitaDestinazione.nome,
        coordDest: form.localitaDestinazione.coord,
        start_datetime: form.start_datetime,
        posti_richiesti: form.posti_richiesti
      };

      const res = await fetch("http://localhost:3001/search", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(bodyToSend)
      });

      const data = await res.json();
      setRisultati(Array.isArray(data) ? data : []);
    } catch(e) {
      console.error("Errore fetch:", e);
      setRisultati([]);
    } finally {
      setLoading(false);
    }
  };

  const openBookingFlowHandler = (ids: string[]) => {
    setBookingType(filtroSlot === "Liberi" ? "richiedi" : "prenota");
    setBookingIds(ids);
    setBookingOpen(true);
  };

  const handleSelect = (id: string) => {
    if(filtroSlot === "Liberi"){
      setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x!==id) : [...prev,id]);
    } else {
      setSelectedIds([id]);
    }
  };

  const risultatiSelezionati = risultati.filter(r => bookingIds.includes(r.id));

  /* ===================== RENDER ===================== */
  return (
    <div className="w-full min-h-screen flex flex-col items-center">

      {/* SEARCH FORM */}
      <SearchForm
        form={form}
        dispatch={dispatch}
        onSubmit={handleSubmit}
        loading={loading}
        isMobile={isMobile}
        openCard={openCard}  // ✅ passa il callback al form
      />

      {/* RISULTATI */}
      <div className="w-full max-w-[1280px] px-4 mt-6">
        <RisultatiSelection
          risultati={risultati}
          filtroSlot={filtroSlot}
          selectedIds={selectedIds}
          onSelect={handleSelect}
          onAction={openBookingFlowHandler}
          isMobile={isMobile}
          setFiltroSlot={setFiltroSlot}
        />
      </div>

      {/* CARD A COMPARSA PER INSERIMENTO */}
      {cardOpen && (
        <BookingCard header={<h3 className="text-lg font-semibold">Inserisci dati</h3>}>
{activeField === "origine" && (
  <LocationSheet
    open={activeField === "origine"}
    query={form.localitaOrigine?.nome || ""}
    setQuery={(q) => dispatch({ type: "SET_ORIGINE", payload: { nome: q, coord: form.localitaOrigine?.coord || [0,0] } })}
    onSelect={(val) => {
      dispatch({ type: "SET_ORIGINE", payload: val });
      // puoi decidere se chiudere la card o no
    }}
    onClose={() => setActiveField(null)}
  />
)}

        {activeField === "destinazione" && (
  <LocationSheet
    open={activeField === "destinazione"}
    query={form.localitaDestinazione?.nome || ""}
    setQuery={(q) => dispatch({ type: "SET_DESTINAZIONE", payload: { nome: q, coord: form.localitaDestinazione?.coord || [0,0] } })}
    onSelect={(val) => {
      dispatch({ type: "SET_DESTINAZIONE", payload: val });
    }}
    onClose={() => setActiveField(null)}
  />
)}

          {activeField === "datetime" && (
            <AppInput
              value={form.start_datetime}
              type="datetime-local"
              onChange={(e) => dispatch({ type: "SET_DATETIME", payload: e.target.value })}
            />
          )}
          {activeField === "posti" && (
            <AppInput
              value={form.posti_richiesti.toString()}
              type="number"
              onChange={(e) => dispatch({ type: "SET_POSTI", payload: Number(e.target.value) })}
            />
          )}

          <button
            onClick={closeCard}
            className="mt-4 w-full bg-[#ff3036] text-white rounded-xl py-2 font-semibold"
          >
            Conferma
          </button>
        </BookingCard>
      )}

      {/* BOOKING FLOW */}
      {bookingOpen && risultatiSelezionati.length > 0 && user && (
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
      )}

    </div>
  );
}
