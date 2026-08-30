import { Suspense } from "react";
import { LoginForm } from "@/components/admin/LoginForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="login-page">
      <h1>Sign in</h1>
      <p className="muted">This blog has one author. Enter the admin password.</p>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
