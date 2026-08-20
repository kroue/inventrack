const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://qkhdouoqkqwkvmpgezay.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFraGRvdW9xa3F3a3ZtcGdlemF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODY1MzEsImV4cCI6MjEwMDA2MjUzMX0.b12il5tzXdLLwn2DJ8BgdMi5Ly7QsDupcht27yMGPSc');

async function test() {
  const { data: prodData } = await supabase.from('products').select('product_id').limit(1);
  const { data: batchData } = await supabase.from('batches').select('batch_id, quantity_remaining').limit(1);
  
  if(prodData.length && batchData.length) {
     const req = [
        {
           product_id: prodData[0].product_id,
           batch_id: batchData[0].batch_id,
           quantity: 1
        }
     ];
     console.log("PAYLOAD:", JSON.stringify(req));
     const { data, error } = await supabase.rpc('process_pos_sale', { p_payment_method: 'Cash', p_items: req });
     console.log("RPC DATA:", data);
     console.log("RPC ERROR:", error);
  } else {
     console.log("No product or batch found to test.");
  }
}
test();
