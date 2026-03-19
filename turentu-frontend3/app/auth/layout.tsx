export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-100">
      <div className="w-full max-w-md bg-white p-6 rounded shadow">
        {children}
      </div>
    </div>
  );
}
