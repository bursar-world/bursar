import { redirect } from 'next/navigation';

/** The public site is bursar.world; this origin is the product, and the product starts at the console. */
export default function Root() {
  redirect('/console');
}
