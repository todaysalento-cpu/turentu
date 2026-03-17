export default function AdminPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold">Dashboard Admin</h1>
      <p>Gestisci utenti, veicoli e statistiche.</p>

      {/* Lista utenti */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="p-4 bg-white dark:bg-zinc-800 rounded shadow flex justify-between items-center">
          <div>
            <h2 className="font-semibold">Utente 1</h2>
            <p>Email: utente1@mail.com</p>
          </div>
          <button className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 transition">
            Rimuovi
          </button>
        </div>
        <div className="p-4 bg-white dark:bg-zinc-800 rounded shadow flex justify-between items-center">
          <div>
            <h2 className="font-semibold">Utente 2</h2>
            <p>Email: utente2@mail.com</p>
          </div>
          <button className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 transition">
            Rimuovi
          </button>
        </div>
      </div>
    </div>
  );
}
