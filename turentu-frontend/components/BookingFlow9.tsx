'use client';

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { loadStripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import { FaArrowLeft } from "react-icons/fa";

import BookingCard from "./BookingCard";
import StepDettagli from "./steps/StepDettagli";
import StepConferma from "./steps/StepConferma";
import StepPagamento from "./steps/StepPagamento";
import { useUser } from "../context/UserContext";

interface Coord { lat: number; lon: number; }

interface Slot {
  veicolo_id: number;
  start_datetime: string;
  durata_minuti: number;
  posti_richiesti: number;
  origine: Coord;
  destinazione: Coord;
  localitaOrigine: string;
  localitaDestinazione: string;
  distanza?: number;
  pending_id?: number;
  posti_totali?: number;
}

interface Props {
  open: boolean;
  type: 'prenota' | 'richiedi';
  onClose: () => void;
  risultatiSelezionati?: any[];
  localitaOrigine?: string;
  localitaDestinazione?: string;
  datetime?: string;
  posti?: number;
  coordOrigine?: Coord;
  coordDestinazione?: Coord;
}

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);
const totalSteps = 3;

export default function BookingFlow({
  open,
  type,
  onClose,
  risultatiSelezionati = [],
  localitaOrigine,
  localitaDestinazione,
  datetime = new Date().toISOString(),
  posti = 1,
  coordOrigine,
  coordDestinazione,
}: Props) {
  const { user } = useUser();
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [loadingPayment, setLoadingPayment] = useState(false);

  // 🔹 Prezzo massimo tra gli slot selezionati
  const prezzoAutorizzazione =
    risultatiSelezionati.length > 0
      ? Math.max(...risultatiSelezionati.map(r => r.prezzo ?? 0))
      : 0;

  // ---------------- HEADER ----------------
  const renderHeader = () => {
    if (confirmed) return null;
    return (
      <div className="flex items-center justify-between p-4">
        <button onClick={step === 0 ? onClose : () => setStep(step - 1)} className="text-gray-700 hover:text-[#ff3036]">
          <FaArrowLeft size={20} />
        </button>
        <div className="flex-1 flex justify-center gap-2">
          {[...Array(totalSteps)].map((_, i) => (
            <div key={i} className={`h-2 w-2 rounded-full ${step >= i ? "bg-[#ff3036]" : "bg-gray-300"}`} />
          ))}
        </div>
        <div className="w-6" />
      </div>
    );
  };

  // ---------------- FOOTER ----------------
  const renderFooter = () => {
    if (confirmed) {
      return (
        <button className="w-full py-3 bg-[#ff3036] text-white rounded-lg font-semibold" onClick={onClose}>
          Chiudi
        </button>
      );
    }

    switch (step) {
      case 0:
        return (
          <button
            className="w-full py-3 bg-[#ff3036] text-white rounded-lg font-semibold"
            onClick={() => setStep(1)}
          >
            {type === "prenota" ? "Conferma dettagli" : "Conferma richiesta"}
          </button>
        );

      case 1:
        return (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-500 text-center px-4">
              Verrà autorizzato il pagamento per lo slot con prezzo più alto.
              L’addebito effettivo avverrà solo se l’autista accetta la richiesta.
            </p>
            <button
              className="w-full py-3 bg-[#ff3036] text-white rounded-lg font-semibold"
              onClick={() => setStep(2)}
              disabled={prezzoAutorizzazione <= 0 && type === "prenota"}
            >
              Prenota il pagamento
            </button>
          </div>
        );

      default:
        return undefined;
    }
  };

  // ---------------- PREPARE SLOTS ----------------
  const preparedSlots: Slot[] = risultatiSelezionati.map(r => ({
    veicolo_id: r.veicolo_id,
    start_datetime: r.oraPartenza ? new Date(r.oraPartenza).toISOString() : datetime,
    durata_minuti: r.durataMinuti ?? Math.floor((r.durataMs ?? 1800000) / 60000),
    posti_richiesti: r.postiRichiesti ?? posti,
    origine: r.coordOrigine ?? coordOrigine ?? { lat: 45.4642, lon: 9.1900 },
    destinazione: r.coordDestinazione ?? coordDestinazione ?? { lat: 45.4650, lon: 9.1850 },
    localitaOrigine: r.localitaOrigine ?? r.origine?.nome ?? localitaOrigine ?? "Piazza Duomo, Milano",
    localitaDestinazione: r.localitaDestinazione ?? r.destinazione?.nome ?? localitaDestinazione ?? "Corso Vittorio Emanuele II, Milano",
    distanza: r.distanza ?? r.distanzaKm ?? 0,
    pending_id: r.pending_id ?? null,
    posti_totali: r.postiTotali ?? 4
  }));

  console.log("🔥 Prepared slots:", preparedSlots);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            className="fixed inset-x-0 bottom-0 z-50 w-full"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25 }}
          >
            <BookingCard header={renderHeader()} footer={renderFooter()}>
              <div className="flex flex-col h-full">
                {!confirmed && step === 0 && (
                  <StepDettagli
                    type={type}
                    localitaOrigine={localitaOrigine}
                    localitaDestinazione={localitaDestinazione}
                    datetime={datetime}
                    posti={posti}
                    risultatiSelezionati={risultatiSelezionati}
                  />
                )}

                {!confirmed && step === 1 && (
                  <StepConferma
                    type={type}
                    risultatiSelezionati={risultatiSelezionati}
                  />
                )}

                {!confirmed && step === 2 && (
                  <Elements stripe={stripePromise}>
                    <StepPagamento
                      type={type}
                      prezzo={prezzoAutorizzazione}
                      slots={preparedSlots}
                      loading={loadingPayment}
                      setLoading={setLoadingPayment}
                      onConfirmSuccess={() => setConfirmed(true)}
                    />
                  </Elements>
                )}

                {confirmed && (
                  <div className="flex flex-col items-center justify-center h-full p-6 text-center">
                    <h2 className="text-2xl font-bold mb-4">
                      {type === "prenota" ? "Prenotazione completata!" : "Richiesta inviata!"}
                    </h2>
                  </div>
                )}
              </div>
            </BookingCard>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}