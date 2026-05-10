import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

export default async function TodosPage() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: todos } = await supabase.from("todos").select();

  return (
    <main className="mx-auto max-w-2xl px-5 py-8 sm:px-8">
      <h1 className="mb-4 text-lg font-semibold">Todos</h1>
      <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
        {todos?.map((todo: { id: string | number; name?: string | null }) => (
          <li key={todo.id}>{todo.name ?? "(no name)"}</li>
        ))}
        {todos?.length === 0 ? <li className="list-none">No rows yet.</li> : null}
        {!todos ? <li className="list-none text-destructive">Could not load todos.</li> : null}
      </ul>
    </main>
  );
}
