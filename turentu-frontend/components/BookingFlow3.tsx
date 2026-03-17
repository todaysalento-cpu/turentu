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

interface Props {
  open: boolean;
  type: 'prenota' | 'richiedi';
  onClose: () => void;
  risultatiSelezionati?: any[];
  localitaOrigine?: string;
  localitaDestinazione?: string;
  datetime?: string;
  posti?: number;
}

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);
const totalSteps = 3;

export default function BookingFlow({
  open,
  type,
  onClose,
  risultatiSelezionati = [],
  localitaOrigine = "N/D",
  localitaDestinazione = "N/D",
  datetime = new Date().toISOString(),
  posti = 1,
}: Props) {
  const { user } = useUser();
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [loadingPayment, setLoadingPayment] = useState(false);

  // ✅ Prendi sempre il prezzo dal backend
  const prezzo = risultatiSelezionati?.[0]?.prezzo ?? 0;

  // Se utente non loggato → guest
  const clienteId = user?.id ?? null;

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
          <button
            className="w-full py-3 bg-[#ff3036] text-white rounded-lg font-semibold"
            onClick={() => setStep(2)}
            disabled={prezzo <= 0 && type === "prenota"}
          >
            Procedi al pagamento
          </button>
        );
      default:
        return undefined;
    }
  };

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
                    prezzo={prezzo} // ✅ prezzo sempre corretto
                  />
                )}

                {!confirmed && step === 1 && (
                  <StepConferma type={type} risultatiSelezionati={risultatiSelezionati} />
                )}

                {!confirmed && step === 2 && (
                  <Elements stripe={stripePromise}>
                    <StepPagamento
                      type={type}
                      prezzo={prezzo}
                      pendingId={risultatiSelezionati?.[0]?.pendingId}
                      corsaId={risultatiSelezionati?.[0]?.id}
                      clienteId={clienteId} // guest se null
                      localitaOrigine={localitaOrigine}
                      localitaDestinazione={localitaDestinazione}
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
