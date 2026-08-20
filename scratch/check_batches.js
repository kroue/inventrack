const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://qkhdouoqkqwkvmpgezay.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFraGRvdW9xa3F3a3ZtcGdlemF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODY1MzEsImV4cCI6MjEwMDA2MjUzMX0.b12il5tzXdLLwn2DJ8BgdMi5Ly7QsDupcht27yMGPSc');

async function check() {
  const { data: batches } = await supabase.from('batches').select('*');
  console.log('BATCHES:', batches);

  const { data: inv } = await supabase.from('inventory').select('*');
  console.log('INVENTORY:', inv);
}
check();
