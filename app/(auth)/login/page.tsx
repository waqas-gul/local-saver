import { LoginForm } from "@/components/account/login-form";

/** /login (§17.5.2): sign in or create an account; on an anonymous browser, upgrade or merge. */
export default function LoginPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-medium">Sign in</h1>
      <LoginForm />
    </div>
  );
}
