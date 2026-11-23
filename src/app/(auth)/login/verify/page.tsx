import { redirect } from "next/navigation";

/** The authenticator step was removed; old links land on the sign-in page. */
export default function VerifyPage() {
  redirect("/login");
}
