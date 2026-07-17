import { config } from './config';
import { shopifyGraphql } from './shopify';

export async function getBillingStatus(shop: string) {
  if (!config.billing.enabled) return { enabled: false, active: true, mode: 'free' as const, subscriptions: [] };
  const data = await shopifyGraphql<{ currentAppInstallation: { activeSubscriptions: Array<{ id:string; name:string; status:string; currentPeriodEnd:string }> } }>(shop, `#graphql
    query SectionOsBilling { currentAppInstallation { activeSubscriptions { id name status currentPeriodEnd } } }
  `);
  return { enabled: true, active: data.currentAppInstallation.activeSubscriptions.some((item)=>item.status==='ACTIVE'), mode:'shopify' as const, subscriptions:data.currentAppInstallation.activeSubscriptions };
}

export async function createSubscription(shop:string){
  if(!config.billing.enabled||config.billing.price<=0)throw new Error('Billing is not enabled.');
  const data=await shopifyGraphql<{appSubscriptionCreate:{confirmationUrl:string|null;appSubscription:{id:string;status:string}|null;userErrors:Array<{message:string}>}}>(shop,`#graphql
    mutation SectionOsSubscribe($name:String!,$returnUrl:URL!,$trialDays:Int,$lineItems:[AppSubscriptionLineItemInput!]!){
      appSubscriptionCreate(name:$name,returnUrl:$returnUrl,trialDays:$trialDays,lineItems:$lineItems){ confirmationUrl appSubscription{id status} userErrors{message} }
    }
  `,{
    name:config.billing.planName,
    returnUrl:`${config.appUrl}/?billing=complete`,
    trialDays:config.billing.trialDays,
    lineItems:[{plan:{appRecurringPricingDetails:{price:{amount:config.billing.price,currencyCode:config.billing.currency},interval:'EVERY_30_DAYS'}}}],
  });
  if(data.appSubscriptionCreate.userErrors.length)throw new Error(data.appSubscriptionCreate.userErrors.map((error)=>error.message).join('; '));
  return data.appSubscriptionCreate;
}
