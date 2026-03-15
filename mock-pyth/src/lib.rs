//! Mock Pyth Receiver program for localnet/test use.
//!
//! Deployed at the real Pyth Receiver address (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`)
//! via `--bpf-program`. Accepts raw bytes and writes them to a target account,
//! enabling tests to construct arbitrary PriceUpdateV2 payloads without Wormhole.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let _payer = next_account_info(accounts_iter)?; // [0] payer (signer)
    let target = next_account_info(accounts_iter)?; // [1] target (writable, owned by this program)

    if target.owner != program_id {
        msg!("Target account not owned by mock-pyth program");
        return Err(ProgramError::IncorrectProgramId);
    }
    if !target.is_writable {
        msg!("Target account must be writable");
        return Err(ProgramError::InvalidArgument);
    }

    let mut data = target.try_borrow_mut_data()?;
    if instruction_data.len() > data.len() {
        msg!("Instruction data exceeds account size");
        return Err(ProgramError::AccountDataTooSmall);
    }
    data[..instruction_data.len()].copy_from_slice(instruction_data);

    Ok(())
}
